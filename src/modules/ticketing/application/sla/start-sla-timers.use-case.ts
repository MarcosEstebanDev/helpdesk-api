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
import { BusinessCalendarRepository } from '../../domain/ports/business-calendar.repository';
import { toBusinessCalendar } from '../../domain/sla/business-calendar';
import { defaultPolicyFor, resolvePolicy } from '../../domain/sla/sla-policy';
import { SLA_KINDS, SlaTimer } from '../../domain/sla/sla-timer.entity';
import { TicketRepository } from '../../domain/ports/ticket.repository';
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
    private readonly tickets: TicketRepository,
    private readonly calendars: BusinessCalendarRepository,
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
        // Los valores de fábrica dependen del modo (horas hábiles o de reloj).
        const horario = await this.calendars.configOf(input.tenantId);
        const overrides = await this.policies.overridesOf(input.tenantId);
        const objetivo = resolvePolicy(
          overrides,
          defaultPolicyFor(horario.mode),
        )[input.priority];

        const minutosPor = {
          RESPONSE: objetivo.responseMinutes,
          RESOLUTION: objetivo.resolutionMinutes,
        };

        // El arranque es diferido y la pausa síncrona (ADR-0029): si el ticket
        // llegó a la espera ANTES de que este job corriera, el coordinador no
        // encontró reloj que pausar. Se mira el estado actual y el de
        // resolución nace pausado. La hora de la pausa es `updatedAt`, la mejor
        // aproximación que guarda el ticket: si hubo actividad después de entrar
        // en la espera es algo posterior a la real, o sea que cuenta de más
        // contra el equipo y nunca de menos.
        const ticket = await this.tickets.findById(
          input.tenantId,
          input.ticketId,
        );
        const enEspera = ticket?.status === 'WAITING_ON_CUSTOMER';
        // Horario laboral de la organización (ADR-0034): un ticket que entra
        // con la oficina cerrada empieza a contar en la próxima apertura.
        const calendar = toBusinessCalendar(horario.config);

        for (const kind of SLA_KINDS) {
          const timer = SlaTimer.start({
            id: SlaTimerId(this.ids.uuid()),
            tenantId: input.tenantId,
            ticketId: input.ticketId,
            kind,
            minutes: minutosPor[kind],
            calendar,
            now: input.occurredAt,
          });
          if (enEspera && kind === 'RESOLUTION') {
            timer.pause(ticket.updatedAt);
          }
          await this.timers.save(timer);
        }

        return ok({ status: 'started', timers: SLA_KINDS.length } as const);
      },
    );
  }
}
