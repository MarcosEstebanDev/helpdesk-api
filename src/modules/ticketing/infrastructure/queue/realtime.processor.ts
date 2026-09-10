import {
  InjectQueue,
  OnWorkerEvent,
  Processor,
  WorkerHost,
} from '@nestjs/bullmq';
import { Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job, Queue } from 'bullmq';
import type { Env } from '../../../../infrastructure/config/env.schema';
import type { EventJobData } from '../../../../infrastructure/outbox/outbox-publisher.service';
import { runWithJobContext } from '../../../../infrastructure/observability/job-context';
import {
  DEAD_LETTER_QUEUE,
  REALTIME_QUEUE,
} from '../../../../infrastructure/queue/queues';
import {
  BroadcastOutcome,
  BroadcastTicketEvent,
} from '../../application/realtime/broadcast-ticket-event.use-case';

/**
 * Empuja a los clientes conectados lo que va ocurriendo (ADR-0023).
 *
 * Es un consumidor más del outbox, como el de enrutado o el de SLA. Eso importa:
 * lo que llega a la pantalla es exactamente lo que quedó escrito en la misma
 * transacción que el cambio, así que no puede anunciarse algo que después se
 * revirtió, ni perderse un aviso porque el WebSocket estaba caído en ese
 * instante — el mensaje sigue en el outbox hasta que se publica.
 *
 * **No usa `processed_messages`.** El resto de consumidores lo necesitan porque
 * sus efectos no son repetibles (asignar dos veces, arrancar dos relojes); aquí
 * el peor caso de un reproceso es que un cliente reciba dos veces el mismo aviso
 * y refresque de más. Pagar una escritura en base de datos por cada mensaje
 * emitido, en el camino que más volumen tiene, sería caro a cambio de nada.
 */
@Processor(REALTIME_QUEUE, { autorun: false })
export class RealtimeProcessor
  extends WorkerHost
  implements OnApplicationBootstrap
{
  private readonly logger = new Logger(RealtimeProcessor.name);

  constructor(
    private readonly broadcast: BroadcastTicketEvent,
    private readonly config: ConfigService<Env, true>,
    @InjectQueue(DEAD_LETTER_QUEUE) private readonly deadLetter: Queue,
  ) {
    super();
  }

  onApplicationBootstrap(): void {
    if (!this.config.get('WORKER_ENABLED', { infer: true })) {
      this.logger.log('Worker de realtime desactivado (WORKER_ENABLED=0)');
      return;
    }
    void this.worker.run();
  }

  /**
   * Todo el trabajo del job corre dentro de la correlación del evento (ADR-0024):
   * sus logs cuelgan de la misma historia que la petición que lo originó.
   */
  process(job: Job<EventJobData>): Promise<BroadcastOutcome> {
    return runWithJobContext(
      job.data.requestId,
      job.data.tenantId,
      async () => {
        const { data } = job;

        if (data.aggregateType !== 'ticket') {
          return this.discard(
            job,
            `agregado no manejado: ${data.aggregateType}`,
          );
        }

        const inicio = Date.now();
        const resultado = await this.broadcast.execute({
          eventName: data.eventName,
          version: data.version,
          tenantId: data.tenantId,
          ticketId: data.aggregateId,
          occurredAt: new Date(data.occurredAt),
          payload: data.payload,
        });

        // Lleva el `requestId` heredado del evento (ADR-0024).
        this.logger.log(
          `${data.eventName} → ${resultado.action} (${Date.now() - inicio}ms)`,
        );
        return resultado;
      },
    );
  }

  // --------------------------------------------------------------------- DLQ

  @OnWorkerEvent('failed')
  async onFailed(
    job: Job<EventJobData> | undefined,
    error: Error,
  ): Promise<void> {
    if (job === undefined) return;

    const intentosMaximos = job.opts.attempts ?? 1;
    if (job.attemptsMade < intentosMaximos) {
      this.logger.warn(
        `Job ${job.id} falló (intento ${job.attemptsMade}/${intentosMaximos}): ${error.message}`,
      );
      return;
    }
    await this.toDeadLetter(job, error.message);
  }

  private async discard(
    job: Job<EventJobData>,
    motivo: string,
  ): Promise<BroadcastOutcome> {
    this.logger.error(`Descartando job ${job.id}: ${motivo}`);
    await this.toDeadLetter(job, motivo);
    return { action: 'ignored', detail: motivo };
  }

  private async toDeadLetter(
    job: Job<EventJobData>,
    motivo: string,
  ): Promise<void> {
    await this.deadLetter.add(
      'failed-job',
      {
        queue: REALTIME_QUEUE,
        jobName: job.name,
        data: job.data,
        reason: motivo,
        attemptsMade: job.attemptsMade,
        failedAt: new Date().toISOString(),
      },
      {
        // Prefijo por cola: el mismo evento va a varias y sin él un descarte
        // pisaría al otro en la DLQ.
        jobId: `dlq-realtime-${job.data.eventId}`,
        removeOnComplete: false,
        removeOnFail: false,
      },
    );
    this.logger.error(`Job ${job.id} enviado a la DLQ: ${motivo}`);
  }
}
