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
import {
  DEAD_LETTER_QUEUE,
  SLA_QUEUE,
} from '../../../../infrastructure/queue/queues';
import { StartSlaTimers } from '../../application/sla/start-sla-timers.use-case';
import { StopSlaTimer } from '../../application/sla/stop-sla-timer.use-case';
import { TenantId, TicketId } from '../../domain/ids';
import { isResponder } from '../../domain/sla/responder-role';
import { isTicketPriority } from '../../domain/ticket-status';

/** Resultado del job, solo informativo (queda en el registro de BullMQ). */
type SlaJobOutcome = { action: string; detail?: string };

/**
 * Motor de SLA del lado de los eventos (ADR-0021).
 *
 * Arranca los relojes al crearse un ticket y los para cuando ocurre lo que
 * estaban esperando. El incumplimiento NO se detecta aquí sino en el barrido:
 * esto solo reacciona a cosas que ya pasaron.
 */
@Processor(SLA_QUEUE, { autorun: false })
export class SlaProcessor extends WorkerHost implements OnApplicationBootstrap {
  private readonly logger = new Logger(SlaProcessor.name);

  constructor(
    private readonly startTimers: StartSlaTimers,
    private readonly stopTimer: StopSlaTimer,
    private readonly config: ConfigService<Env, true>,
    @InjectQueue(DEAD_LETTER_QUEUE) private readonly deadLetter: Queue,
  ) {
    super();
  }

  onApplicationBootstrap(): void {
    if (!this.config.get('WORKER_ENABLED', { infer: true })) {
      this.logger.log('Worker de SLA desactivado (WORKER_ENABLED=0)');
      return;
    }
    void this.worker.run();
  }

  async process(job: Job<EventJobData>): Promise<SlaJobOutcome> {
    const data = job.data;
    const occurredAt = new Date(data.occurredAt);

    switch (data.eventName) {
      case 'ticket.created':
        return this.onTicketCreated(job, occurredAt);
      case 'comment.added':
        return this.onCommentAdded(job, occurredAt);
      case 'ticket.status_changed':
        return this.onStatusChanged(job, occurredAt);
      default:
        return this.discard(job, `evento no manejado: ${data.eventName}`);
    }
  }

  // -------------------------------------------------------------- handlers

  private async onTicketCreated(
    job: Job<EventJobData>,
    occurredAt: Date,
  ): Promise<SlaJobOutcome> {
    const { data } = job;
    if (data.version !== 1) {
      return this.discard(job, `ticket.created v${data.version} no soportado`);
    }

    const priority = data.payload.priority;
    if (typeof priority !== 'string' || !isTicketPriority(priority)) {
      return this.discard(job, 'el payload no trae una prioridad válida');
    }

    const result = await this.startTimers.execute({
      eventId: data.eventId,
      tenantId: TenantId(data.tenantId),
      ticketId: TicketId(data.aggregateId),
      priority,
      occurredAt,
    });
    if (result.isErr()) {
      throw new Error(`No se pudieron arrancar los SLA: ${result.error.code}`);
    }
    return { action: result.value.status };
  }

  private async onCommentAdded(
    job: Job<EventJobData>,
    occurredAt: Date,
  ): Promise<SlaJobOutcome> {
    const { data } = job;

    // v1 no traía el rol del autor, y sin él no se puede distinguir la respuesta
    // de un agente de un mensaje del propio cliente. Es un fallo PERMANENTE:
    // reintentar no va a añadir el campo. (Ningún v1 llegó a tener consumidor,
    // así que en la práctica no debería aparecer ninguno.)
    if (data.version < 2) {
      return this.discard(
        job,
        `comment.added v${data.version} no trae authorRole`,
      );
    }

    const authorRole = data.payload.authorRole;
    if (typeof authorRole !== 'string') {
      return this.discard(job, 'el payload no trae authorRole');
    }

    if (!isResponder(authorRole)) {
      // Comentario del cliente: no para nada. Si lo parara, bastaría con que
      // insistiera para que su propio SLA de respuesta se diera por cumplido.
      return { action: 'ignored', detail: 'comentario del solicitante' };
    }

    const result = await this.stopTimer.execute({
      eventId: data.eventId,
      tenantId: TenantId(data.tenantId),
      ticketId: TicketId(data.aggregateId),
      kind: 'RESPONSE',
      occurredAt,
    });
    if (result.isErr()) {
      throw new Error(
        `No se pudo parar el SLA de respuesta: ${result.error.code}`,
      );
    }
    return { action: result.value.status };
  }

  private async onStatusChanged(
    job: Job<EventJobData>,
    occurredAt: Date,
  ): Promise<SlaJobOutcome> {
    const { data } = job;
    const to = data.payload.to;

    // Solo resolver para el reloj de resolución. Cerrar no lo para porque un
    // ticket solo se cierra desde RESOLVED, así que ya estaba parado; y reabrir
    // no lo reanuda: el reloj original ya cumplió su función, y el tiempo del
    // segundo intento es una medida distinta que hoy no se modela.
    if (to !== 'RESOLVED') {
      return { action: 'ignored', detail: `transición a ${String(to)}` };
    }

    const result = await this.stopTimer.execute({
      eventId: data.eventId,
      tenantId: TenantId(data.tenantId),
      ticketId: TicketId(data.aggregateId),
      kind: 'RESOLUTION',
      occurredAt,
    });
    if (result.isErr()) {
      throw new Error(
        `No se pudo parar el SLA de resolución: ${result.error.code}`,
      );
    }
    return { action: result.value.status };
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
  ): Promise<SlaJobOutcome> {
    this.logger.error(`Descartando job ${job.id}: ${motivo}`);
    await this.toDeadLetter(job, motivo);
    return { action: 'discarded', detail: motivo };
  }

  private async toDeadLetter(
    job: Job<EventJobData>,
    motivo: string,
  ): Promise<void> {
    await this.deadLetter.add(
      'failed-job',
      {
        queue: SLA_QUEUE,
        jobName: job.name,
        data: job.data,
        reason: motivo,
        attemptsMade: job.attemptsMade,
        failedAt: new Date().toISOString(),
      },
      {
        // El prefijo incluye la cola: el mismo evento va a `ticket-routing` y a
        // `sla`, y sin él el segundo descarte pisaría al primero en la DLQ.
        jobId: `dlq-sla-${job.data.eventId}`,
        removeOnComplete: false,
        removeOnFail: false,
      },
    );
    this.logger.error(`Job ${job.id} enviado a la DLQ: ${motivo}`);
  }
}
