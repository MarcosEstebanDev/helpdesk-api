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
  TICKET_ROUTING_QUEUE,
} from '../../../../infrastructure/queue/queues';
import {
  AutoAssignOutcome,
  AutoAssignTicket,
} from '../../application/auto-assign-ticket.use-case';
import { TenantId, TicketId } from '../../domain/ids';

/** Versión del evento `ticket.created` que este consumidor sabe interpretar. */
const SUPPORTED_VERSION = 1;

/**
 * Consumidor de la cola de enrutado de tickets (ADR-0019).
 *
 * `autorun: false` en el decorador: el worker no arranca solo, lo arranca
 * {@link onApplicationBootstrap} si `WORKER_ENABLED` lo permite. Eso hace dos
 * cosas útiles — separar mañana el despliegue de workers del de la API es
 * cambiar una variable de entorno, y los tests e2e pueden dirigir el flujo paso
 * a paso en vez de competir con un worker que consume por su cuenta.
 */
@Processor(TICKET_ROUTING_QUEUE, { autorun: false })
export class TicketRoutingProcessor
  extends WorkerHost
  implements OnApplicationBootstrap
{
  private readonly logger = new Logger(TicketRoutingProcessor.name);

  constructor(
    private readonly autoAssign: AutoAssignTicket,
    private readonly config: ConfigService<Env, true>,
    @InjectQueue(DEAD_LETTER_QUEUE) private readonly deadLetter: Queue,
  ) {
    super();
  }

  onApplicationBootstrap(): void {
    if (!this.config.get('WORKER_ENABLED', { infer: true })) {
      this.logger.log('Worker de tickets desactivado (WORKER_ENABLED=0)');
      return;
    }
    void this.worker.run();
  }

  /**
   * Todo el trabajo del job corre dentro de la correlación del evento (ADR-0024):
   * sus logs cuelgan de la misma historia que la petición que lo originó.
   */
  process(job: Job<EventJobData>): Promise<AutoAssignOutcome> {
    return runWithJobContext(
      job.data.requestId,
      job.data.tenantId,
      async () => {
        const data = job.data;

        if (data.eventName !== 'ticket.created') {
          // La cola solo debería traer este evento; si llega otro, el mapa de
          // enrutado y este consumidor se han desincronizado.
          return this.discard(job, `evento no manejado: ${data.eventName}`);
        }

        if (data.version !== SUPPORTED_VERSION) {
          // Reintentar no arregla un formato que no entendemos: es un fallo
          // PERMANENTE, así que va directo al descarte en vez de gastar 5 intentos.
          return this.discard(job, `versión no soportada: ${data.version}`);
        }

        const numero = data.payload.number;
        if (typeof numero !== 'number') {
          return this.discard(job, 'el payload no trae `number`');
        }

        const inicio = Date.now();
        const result = await this.autoAssign.execute({
          eventId: data.eventId,
          tenantId: TenantId(data.tenantId),
          ticketId: TicketId(data.aggregateId),
          ticketNumber: numero,
        });

        if (result.isErr()) {
          // Error de dominio inesperado: se LANZA para que BullMQ aplique su
          // política de reintentos. Las situaciones definitivas (ticket borrado,
          // sin agentes...) no llegan aquí: el caso de uso las devuelve `skipped`.
          throw new Error(
            `Auto-asignación fallida (${result.error.code}): ${result.error.message}`,
          );
        }

        // Un worker que solo habla cuando falla es un worker que no se puede
        // observar: no hay forma de saber si está trabajando, ni cuánto tarda, ni
        // qué decidió. La línea lleva el `requestId` heredado del evento, así que
        // aparece junto a la petición HTTP que lo originó (ADR-0024).
        this.logger.log(
          `${data.eventName} → ${result.value.status} (${Date.now() - inicio}ms)`,
        );
        return result.value;
      },
    );
  }

  /**
   * Manda el job a la dead-letter queue cuando agota sus reintentos.
   *
   * BullMQ no trae DLQ: lo que ofrece es este evento. Se copia el job a una cola
   * aparte —con el motivo y el número de intentos— para que quede localizable sin
   * tener que rebuscar entre los fallidos de la cola principal.
   */
  @OnWorkerEvent('failed')
  async onFailed(
    job: Job<EventJobData> | undefined,
    error: Error,
  ): Promise<void> {
    if (job === undefined) return;

    const intentosMaximos = job.opts.attempts ?? 1;
    if (job.attemptsMade < intentosMaximos) {
      // Todavía le quedan reintentos: no es un descarte, es un tropiezo.
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
  ): Promise<AutoAssignOutcome> {
    this.logger.error(`Descartando job ${job.id}: ${motivo}`);
    await this.toDeadLetter(job, motivo);
    // Se resuelve como "saltado" en vez de lanzar: reintentar un fallo
    // permanente solo consume la cola sin cambiar nada.
    return { status: 'skipped', reason: 'not_assignable' };
  }

  private async toDeadLetter(
    job: Job<EventJobData>,
    motivo: string,
  ): Promise<void> {
    await this.deadLetter.add(
      'failed-job',
      {
        queue: TICKET_ROUTING_QUEUE,
        jobName: job.name,
        data: job.data,
        reason: motivo,
        attemptsMade: job.attemptsMade,
        failedAt: new Date().toISOString(),
      },
      {
        // El id del evento: si el mismo mensaje acaba descartado dos veces, la
        // DLQ no acumula copias. Con guion y no con dos puntos: BullMQ rechaza
        // los `:` en un jobId (los usa como separador de sus propias claves).
        jobId: `dlq-${job.data.eventId}`,
        removeOnComplete: false,
        removeOnFail: false,
      },
    );
    this.logger.error(`Job ${job.id} enviado a la DLQ: ${motivo}`);
  }
}
