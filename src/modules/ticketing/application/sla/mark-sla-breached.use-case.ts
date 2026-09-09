import {
  Clock,
  Result,
  TransactionManager,
  ok,
} from '../../../../shared-kernel';
import { TicketingError } from '../../domain/errors';
import { SlaTimerId, TenantId } from '../../domain/ids';
import { SlaTimerRepository } from '../../domain/ports/sla.repository';
import { TicketRepository } from '../../domain/ports/ticket.repository';
import { SYSTEM_ACTOR_ID } from '../../domain/system-actor';
import { AuditRecorder } from '../audit-recorder';
import { EventRecorder } from '../event-recorder';
import { runTransactional } from '../transactional';

export interface MarkSlaBreachedInput {
  tenantId: TenantId;
  timerId: SlaTimerId;
}

export type MarkSlaBreachedOutcome =
  | { status: 'breached'; kind: string }
  | {
      status: 'skipped';
      reason: 'not_found' | 'not_running' | 'not_overdue' | 'ticket_not_found';
    };

/**
 * Marca el incumplimiento de un reloj vencido (ADR-0021).
 *
 * Lo invoca el barrido, que ya sabe qué relojes han pasado su hora. Aun así
 * **vuelve a comprobarlo todo aquí dentro**, en la transacción: entre que el
 * barrido leyó la lista y llega a este punto, alguien puede haber respondido y
 * parado el reloj. Confiar en la lectura del barrido registraría incumplimientos
 * de SLA que sí se cumplieron.
 *
 * Esa recomprobación es además lo que hace innecesario bloquear filas en el
 * barrido: si dos instancias procesan el mismo reloj, la segunda encuentra que
 * ya no está corriendo y se retira. Idempotencia por condición, no por bloqueo.
 */
export class MarkSlaBreached {
  constructor(
    private readonly transactions: TransactionManager,
    private readonly timers: SlaTimerRepository,
    private readonly tickets: TicketRepository,
    private readonly audit: AuditRecorder,
    private readonly events: EventRecorder,
    private readonly clock: Clock,
  ) {}

  async execute(
    input: MarkSlaBreachedInput,
  ): Promise<Result<MarkSlaBreachedOutcome, TicketingError>> {
    const now = this.clock.now();

    return runTransactional<MarkSlaBreachedOutcome, TicketingError>(
      this.transactions,
      input.tenantId,
      async () => {
        const timer = await this.timers.findById(input.tenantId, input.timerId);
        if (timer === null) {
          return ok({ status: 'skipped', reason: 'not_found' } as const);
        }
        if (!timer.isRunning()) {
          // Alguien lo paró entre el barrido y este momento. Es lo normal, no un
          // fallo: significa que el SLA se cumplió a tiempo.
          return ok({ status: 'skipped', reason: 'not_running' } as const);
        }
        if (!timer.isOverdue(now)) {
          return ok({ status: 'skipped', reason: 'not_overdue' } as const);
        }

        const ticket = await this.tickets.findById(
          input.tenantId,
          timer.ticketId,
        );
        if (ticket === null) {
          return ok({
            status: 'skipped',
            reason: 'ticket_not_found',
          } as const);
        }

        timer.markBreached(now);
        await this.timers.save(timer);

        // El incumplimiento se registra con la hora en que DEBÍA haberse
        // cumplido, no con la del barrido: el retraso real es ese, y el barrido
        // puede haber llegado tarde.
        await this.audit.record({
          tenantId: input.tenantId,
          actorId: SYSTEM_ACTOR_ID,
          action: 'sla.breached',
          entityType: 'ticket',
          entityId: ticket.id,
          metadata: {
            timerId: timer.id,
            kind: timer.kind,
            dueAt: timer.dueAt.toISOString(),
            automatic: true,
          },
          now,
        });

        // El evento sale del TICKET: un consumidor de escalado necesita saber la
        // prioridad y a quién está asignado, no solo que un reloj venció.
        ticket.recordSlaBreach(
          { timerId: timer.id, kind: timer.kind, dueAt: timer.dueAt },
          now,
        );
        await this.events.record(ticket);

        return ok({ status: 'breached', kind: timer.kind } as const);
      },
    );
  }
}
