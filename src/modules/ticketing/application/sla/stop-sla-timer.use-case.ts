import {
  ProcessedMessages,
  Result,
  TransactionManager,
  ok,
} from '../../../../shared-kernel';
import { TicketingError } from '../../domain/errors';
import { TenantId, TicketId } from '../../domain/ids';
import { SlaTimerRepository } from '../../domain/ports/sla.repository';
import { SlaKind } from '../../domain/sla/sla-timer.entity';
import { runTransactional } from '../transactional';

export const STOP_SLA_CONSUMER = 'ticketing.sla-stop';

export interface StopSlaTimerInput {
  eventId: string;
  tenantId: TenantId;
  ticketId: TicketId;
  kind: SlaKind;
  /** Instante del hecho que para el reloj, no el del job. */
  occurredAt: Date;
}

export type StopSlaOutcome =
  | { status: 'stopped'; remainingMinutes: number }
  | {
      status: 'skipped';
      reason: 'already_processed' | 'no_running_timer';
    };

/**
 * Para un reloj de SLA porque ocurrió lo que estaba esperando (ADR-0021):
 * la primera respuesta de un agente, o la resolución del ticket.
 *
 * Se para con `occurredAt` y no con el instante del job por el mismo motivo por
 * el que se arranca así: si la cola va lenta, un SLA cumplido por los pelos
 * podría registrarse como incumplido. El momento que cuenta es cuando la persona
 * hizo la cosa, no cuando la infraestructura se enteró.
 *
 * Que no haya reloj corriendo NO es un error: el ticket puede haberse resuelto
 * dos veces, o el agente haber comentado cuando el reloj de respuesta ya estaba
 * parado. Se devuelve como `skipped`.
 */
export class StopSlaTimer {
  constructor(
    private readonly transactions: TransactionManager,
    private readonly timers: SlaTimerRepository,
    private readonly processed: ProcessedMessages,
  ) {}

  async execute(
    input: StopSlaTimerInput,
  ): Promise<Result<StopSlaOutcome, TicketingError>> {
    return runTransactional<StopSlaOutcome, TicketingError>(
      this.transactions,
      input.tenantId,
      async () => {
        const primeraVez = await this.processed.claim({
          // El consumidor incluye el TIPO de reloj: un mismo evento puede tener
          // que parar el de respuesta y, en otro momento, el de resolución.
          consumer: `${STOP_SLA_CONSUMER}:${input.kind}`,
          eventId: input.eventId,
          tenantId: input.tenantId,
        });
        if (!primeraVez) {
          return ok({
            status: 'skipped',
            reason: 'already_processed',
          } as const);
        }

        const timer = await this.timers.findRunning(
          input.tenantId,
          input.ticketId,
          input.kind,
        );
        if (timer === null) {
          return ok({
            status: 'skipped',
            reason: 'no_running_timer',
          } as const);
        }

        const margen = timer.remainingMinutesAt(input.occurredAt);
        timer.stop(input.occurredAt);
        await this.timers.save(timer);

        return ok({ status: 'stopped', remainingMinutes: margen } as const);
      },
    );
  }
}
