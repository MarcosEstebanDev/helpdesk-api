import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema';
import { QueueRegistry } from '../queue/queue-registry';
import { queuesFor } from '../queue/queues';
import { ClaimedMessage, OutboxReader } from './outbox-reader';

/**
 * Datos que viajan en el job. Es el evento del outbox tal cual, más su `id` de
 * mensaje: el consumidor lo necesita para la idempotencia (ADR-0019).
 */
export interface EventJobData {
  eventId: string;
  tenantId: string;
  aggregateType: string;
  aggregateId: string;
  eventName: string;
  version: number;
  payload: Record<string, unknown>;
  occurredAt: string;
}

/**
 * Drena el outbox hacia las colas (ADR-0019).
 *
 * **Por polling y no por LISTEN/NOTIFY.** Un NOTIFY que llega mientras el
 * publicador está reiniciando se pierde y ese evento no se publicaría nunca —
 * justo la garantía por la que existe el outbox. El polling, en cambio, se
 * recupera solo: lo que quedó pendiente se recoge en el siguiente tick.
 *
 * **Entrega at-least-once.** Los jobs se encolan ANTES de que la transacción que
 * los marca como publicados haga commit. Si el proceso muere entre ambas cosas,
 * el mensaje se vuelve a reclamar y se encola otra vez. Se prefiere duplicar a
 * perder: duplicar lo resuelve el consumidor con `processed_messages`, mientras
 * que un evento perdido no lo arregla nadie.
 */
@Injectable()
export class OutboxPublisher
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(OutboxPublisher.name);
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(
    private readonly reader: OutboxReader,
    private readonly config: ConfigService<Env, true>,
    private readonly queues: QueueRegistry,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.get('WORKER_ENABLED', { infer: true })) {
      this.logger.log('Publicador del outbox desactivado (WORKER_ENABLED=0)');
      return;
    }
    this.scheduleNext();
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * Publica un lote. Devuelve cuántos mensajes se procesaron.
   *
   * Es público y sin temporizador a propósito: así los tests lo dirigen paso a
   * paso en vez de esperar a que salte un intervalo, que es de donde salen los
   * tests intermitentes.
   */
  async publishPending(): Promise<number> {
    const limit = this.config.get('OUTBOX_BATCH_SIZE', { infer: true });
    const maxAttempts = this.config.get('OUTBOX_MAX_ATTEMPTS', { infer: true });

    return this.reader.withClaimedBatch(
      { limit, maxAttempts },
      async (messages, marker) => {
        const publicados: string[] = [];

        for (const message of messages) {
          try {
            await this.enqueue(message);
            publicados.push(message.id);
          } catch (error) {
            // Un mensaje que no se puede encolar no debe frenar al resto del
            // lote: se le suma un intento y se sigue. Cuando agote
            // OUTBOX_MAX_ATTEMPTS dejará de reclamarse.
            const detalle =
              error instanceof Error ? error.message : String(error);
            await marker.markFailed(message.id, detalle);
            this.logger.error(
              `No se pudo encolar el evento ${message.eventName} (${message.id}): ${detalle}`,
            );
          }
        }

        await marker.markPublished(publicados);
        return messages.length;
      },
    );
  }

  private async enqueue(message: ClaimedMessage): Promise<void> {
    const colas = queuesFor(message.eventName);
    if (colas.length === 0) {
      // Nadie escucha este evento. Se marca publicado igualmente: si no, se
      // reclamaría en cada tick para siempre.
      return;
    }

    const data: EventJobData = {
      eventId: message.id,
      tenantId: message.tenantId,
      aggregateType: message.aggregateType,
      aggregateId: message.aggregateId,
      eventName: message.eventName,
      version: message.version,
      payload: message.payload,
      occurredAt: message.occurredAt.toISOString(),
    };

    for (const nombre of colas) {
      const cola = this.queues.get(nombre);
      if (cola === null) {
        // El mapa de enrutado nombra una cola que nadie registró: es un error de
        // programación, y lanzar hace que el mensaje sume un intento en vez de
        // darse por publicado sin que nadie lo haya recibido.
        throw new Error(`Cola no registrada: ${nombre}`);
      }
      await cola.add(message.eventName, data, {
        // Primera capa de deduplicación: BullMQ rechaza un jobId que ya conoce.
        // Solo dura lo que la retención de Redis, de ahí que la garantía REAL
        // sea `processed_messages` en el consumidor (ADR-0019).
        jobId: message.id,
        attempts: this.config.get('QUEUE_JOB_ATTEMPTS', { infer: true }),
        backoff: {
          type: 'exponential',
          delay: this.config.get('QUEUE_BACKOFF_MS', { infer: true }),
        },
        // Se conserva el job fallido para poder inspeccionarlo; los completados
        // se limpian solos para que Redis no crezca sin límite.
        removeOnComplete: 1000,
        removeOnFail: false,
      });
    }
  }

  private scheduleNext(): void {
    if (this.stopped) return;

    const interval = this.config.get('OUTBOX_POLL_INTERVAL_MS', {
      infer: true,
    });

    this.timer = setTimeout(() => {
      void this.tick().finally(() => this.scheduleNext());
    }, interval);
    // No mantiene vivo el proceso si es lo único que queda pendiente.
    this.timer.unref();
  }

  /**
   * Un ciclo del bucle. Nunca lanza: si algo falla —la base de datos caída,
   * Redis inaccesible— se registra y se reintenta en el siguiente tick. Dejar
   * escapar la excepción mataría el bucle y el outbox dejaría de drenarse en
   * silencio, que es el peor final posible para este componente.
   */
  private async tick(): Promise<void> {
    try {
      await this.publishPending();
    } catch (error) {
      this.logger.error(
        `Fallo publicando el outbox: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
