import {
  IdGenerator,
  ProcessedMessages,
  Result,
  TransactionManager,
  ok,
} from '../../../../shared-kernel';
import { TicketingError } from '../../domain/errors';
import { SlaTimerId, TenantId, TicketId } from '../../domain/ids';
import {
  SlaPolicyRepository,
  SlaTimerRepository,
} from '../../domain/ports/sla.repository';
import { CALENDAR_24_7 } from '../../domain/sla/sla-calendar';
import { resolvePolicy } from '../../domain/sla/sla-policy';
import { SLA_KINDS, SlaTimer } from '../../domain/sla/sla-timer.entity';
import { TicketPriority } from '../../domain/ticket-status';
import { runTransactional } from '../transactional';

export const START_SLA_CONSUMER = 'ticketing.sla-start';

export interface StartSlaTimersInput {
  eventId: string;
  tenantId: TenantId;
  ticketId: TicketId;
  priority: TicketPriority;
  /** Instante en que se creó el ticket, no el instante en que corre el job. */
  occurredAt: Date;
}

export type StartSlaOutcome =
  | { status: 'started'; timers: number }
  | { status: 'skipped'; reason: 'already_processed' };

/**
 * Arranca los dos relojes de SLA de un ticket recién creado (ADR-0021).
 *
 * **Los relojes cuentan desde `occurredAt`, no desde ahora.** El job puede
 * ejecutarse segundos —o minutos, si hubo reintentos— después de que el ticket
 * se creara. Contar desde el instante del job regalaría ese tiempo, y bastaría
 * con que la cola fuera lenta para que ningún SLA incumpliera nunca.
 */
export class StartSlaTimers {
  constructor(
    private readonly transactions: TransactionManager,
    private readonly policies: SlaPolicyRepository,
    private readonly timers: SlaTimerRepository,
    private readonly processed: ProcessedMessages,
    private readonly ids: IdGenerator,
  ) {}

  async execute(
    input: StartSlaTimersInput,
  ): Promise<Result<StartSlaOutcome, TicketingError>> {
    return runTransactional<StartSlaOutcome, TicketingError>(
      this.transactions,
      input.tenantId,
      async () => {
        const primeraVez = await this.processed.claim({
          consumer: START_SLA_CONSUMER,
          eventId: input.eventId,
          tenantId: input.tenantId,
        });
        if (!primeraVez) {
          return ok({
            status: 'skipped',
            reason: 'already_processed',
          } as const);
        }

        // Lo que el tenant haya configurado, completado con los valores por
        // defecto del dominio. Una organización sin fila alguna tiene SLA igual.
        const overrides = await this.policies.overridesOf(input.tenantId);
        const objetivo = resolvePolicy(overrides)[input.priority];

        const minutosPor = {
          RESPONSE: objetivo.responseMinutes,
          RESOLUTION: objetivo.resolutionMinutes,
        };

        for (const kind of SLA_KINDS) {
          await this.timers.save(
            SlaTimer.start({
              id: SlaTimerId(this.ids.uuid()),
              tenantId: input.tenantId,
              ticketId: input.ticketId,
              kind,
              minutes: minutosPor[kind],
              calendar: CALENDAR_24_7,
              now: input.occurredAt,
            }),
          );
        }

        return ok({ status: 'started', timers: SLA_KINDS.length } as const);
      },
    );
  }
}
