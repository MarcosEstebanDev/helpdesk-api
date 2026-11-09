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
  AI_TRIAGE_QUEUE,
  DEAD_LETTER_QUEUE,
} from '../../../../infrastructure/queue/queues';
import { TriageRejectedError } from '../../domain/errors';
import { TenantId, TicketId } from '../../domain/ids';
import {
  TriageOutcome,
  TriageTicket,
} from '../../application/triage/triage-ticket.use-case';

const SUPPORTED_VERSION = 1;

/**
 * `lockDuration` holgado a propósito. BullMQ considera "colgado" un job que no
 * renueva su lock en 30 s (el valor por defecto) y lo vuelve a entregar a otro
 * worker MIENTRAS el primero sigue esperando al modelo: dos llamadas pagadas por
 * el mismo ticket. Un modelo local en CPU tarda ~90 s en el primer ticket tras
 * arrancar, así que el lock tiene que cubrir el timeout del cliente HTTP
 * (`AI_TIMEOUT_MS`, 120 s por defecto) con margen.
 */
const LOCK_DURATION_MS = 180_000;

export type AiTriageJobOutcome =
  | TriageOutcome
  | { status: 'skipped'; reason: 'disabled' | 'discarded' };

/**
 * Consumidor de la cola `ai-triage` (ADR-0027). Mismo patrón que el de
 * enrutado: `autorun: false`, correlación del evento, DLQ propia.
 *
 * `concurrency` queda en 1 (el valor por defecto): con un modelo local, varios
 * tickets a la vez no van más rápido, solo hacen más lenta cada respuesta.
 */
@Processor(AI_TRIAGE_QUEUE, {
  autorun: false,
  lockDuration: LOCK_DURATION_MS,
})
export class AiTriageProcessor
  extends WorkerHost
  implements OnApplicationBootstrap
{
  private readonly logger = new Logger(AiTriageProcessor.name);

  constructor(
    private readonly triage: TriageTicket,
    private readonly config: ConfigService<Env, true>,
    @InjectQueue(DEAD_LETTER_QUEUE) private readonly deadLetter: Queue,
  ) {
    super();
  }

  onApplicationBootstrap(): void {
    if (!this.config.get('WORKER_ENABLED', { infer: true })) {
      return;
    }
    // Si no hay servicio de IA el worker arranca igual y descarta los eventos
    // como "desactivado": así la cola no crece sin límite en Redis esperando a
    // un servicio que no existe.
    void this.worker.run();
  }

  process(job: Job<EventJobData>): Promise<AiTriageJobOutcome> {
    return runWithJobContext(
      job.data.requestId,
      job.data.tenantId,
      async () => {
        const data = job.data;

        if (this.config.get('AI_SERVICE_URL', { infer: true }) === undefined) {
          return { status: 'skipped', reason: 'disabled' } as const;
        }
        if (data.eventName !== 'ticket.created') {
          return this.discard(job, `evento no manejado: ${data.eventName}`);
        }
        if (data.version !== SUPPORTED_VERSION) {
          return this.discard(job, `versión no soportada: ${data.version}`);
        }

        const inicio = Date.now();
        const result = await this.triage.execute({
          eventId: data.eventId,
          tenantId: TenantId(data.tenantId),
          ticketId: TicketId(data.aggregateId),
        });

        if (result.isErr()) {
          if (result.error instanceof TriageRejectedError) {
            // Permanente: el mismo texto daría el mismo rechazo.
            return this.discard(job, result.error.message);
          }
          // Transitorio (servicio caído, timeout): que BullMQ reintente.
          throw new Error(
            `Triage fallido (${result.error.code}): ${result.error.message}`,
          );
        }

        this.logger.log(
          `${data.eventName} → triage ${result.value.status} (${Date.now() - inicio}ms)`,
        );
        return result.value;
      },
    );
  }

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
  ): Promise<AiTriageJobOutcome> {
    this.logger.error(`Descartando job ${job.id}: ${motivo}`);
    await this.toDeadLetter(job, motivo);
    return { status: 'skipped', reason: 'discarded' };
  }

  private async toDeadLetter(
    job: Job<EventJobData>,
    motivo: string,
  ): Promise<void> {
    await this.deadLetter.add(
      'failed-job',
      {
        queue: AI_TRIAGE_QUEUE,
        jobName: job.name,
        data: job.data,
        reason: motivo,
        attemptsMade: job.attemptsMade,
        failedAt: new Date().toISOString(),
      },
      {
        // Prefijo propio: el mismo evento puede acabar en la DLQ desde otra cola
        // (routing, sla) y no debe pisar esa entrada.
        jobId: `dlq-ai-${job.data.eventId}`,
        removeOnComplete: false,
        removeOnFail: false,
      },
    );
    this.logger.error(`Job ${job.id} enviado a la DLQ: ${motivo}`);
  }
}
