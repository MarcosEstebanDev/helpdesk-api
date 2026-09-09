import {
  Clock,
  ProcessedMessages,
  Result,
  TransactionManager,
  ok,
} from '../../../shared-kernel';
import { TicketingError } from '../domain/errors';
import { TenantId, TicketId, UserId } from '../domain/ids';
import { MemberDirectory } from '../domain/ports/member.directory';
import { TicketRepository } from '../domain/ports/ticket.repository';
import { SYSTEM_ACTOR_ID } from '../domain/system-actor';
import { AuditRecorder } from './audit-recorder';
import { EventRecorder } from './event-recorder';
import { runTransactional } from './transactional';

/** Nombre con el que este consumidor se registra en `processed_messages`. */
export const AUTO_ASSIGN_CONSUMER = 'ticketing.auto-assign';

export interface AutoAssignTicketInput {
  /** Id del MENSAJE del outbox; es la clave de idempotencia (ADR-0019). */
  eventId: string;
  tenantId: TenantId;
  ticketId: TicketId;
  /** Número visible del ticket: es lo que determina a quién le toca. */
  ticketNumber: number;
}

export type AutoAssignOutcome =
  | { status: 'assigned'; assigneeId: UserId }
  | {
      status: 'skipped';
      reason:
        | 'already_processed'
        | 'ticket_not_found'
        | 'already_assigned'
        | 'no_agents'
        | 'not_assignable';
    };

/**
 * Reparte automáticamente un ticket recién creado entre los agentes del tenant.
 *
 * **El reparto es round-robin SIN estado.** El agente le toca al ticket por
 * `(number - 1) % agentes.length`, siendo `number` la numeración correlativa por
 * organización del ADR-0017. El ticket #1 va al primer agente, el #2 al segundo,
 * y así: es round-robin de verdad, pero sin un contador que mantener, sin una
 * fila que bloquear y —lo que más importa aquí— DETERMINISTA. Reprocesar el
 * mismo evento da el mismo agente, así que la idempotencia no depende solo de la
 * tabla de procesados: aunque fallara, no habría dos repartos distintos.
 *
 * El precio es que alta o baja de agentes desplaza la rotación. Para un reparto
 * automático, que solo pretende que ningún ticket se quede sin dueño, es
 * irrelevante; si algún día hace falta equilibrar carga de verdad, el criterio
 * pasaría a ser "el agente con menos tickets abiertos" y este comentario sería
 * el sitio donde mirar.
 *
 * Todo ocurre en UNA transacción (ADR-0016) junto con la marca de procesado: si
 * el trabajo revierte, la marca revierte con él y el reintento vuelve a
 * intentarlo. Marcarlo fuera sería peor que no marcarlo.
 */
export class AutoAssignTicket {
  constructor(
    private readonly transactions: TransactionManager,
    private readonly tickets: TicketRepository,
    private readonly members: MemberDirectory,
    private readonly processed: ProcessedMessages,
    private readonly audit: AuditRecorder,
    private readonly events: EventRecorder,
    private readonly clock: Clock,
  ) {}

  async execute(
    input: AutoAssignTicketInput,
  ): Promise<Result<AutoAssignOutcome, TicketingError>> {
    const now = this.clock.now();

    // Genéricos explícitos: si no, TypeScript infiere el tipo del PRIMER `return`
    // y luego rechaza los demás `skipped`, que son igual de válidos.
    return runTransactional<AutoAssignOutcome, TicketingError>(
      this.transactions,
      input.tenantId,
      async () => {
        const primeraVez = await this.processed.claim({
          consumer: AUTO_ASSIGN_CONSUMER,
          eventId: input.eventId,
          tenantId: input.tenantId,
        });
        if (!primeraVez) {
          return ok({
            status: 'skipped',
            reason: 'already_processed',
          } as const);
        }

        const ticket = await this.tickets.findById(
          input.tenantId,
          input.ticketId,
        );
        // Los "skipped" se devuelven como OK y no como error a propósito: son
        // situaciones definitivas, no fallos. Devolver `err` revertiría la marca de
        // procesado y el job se reintentaría hasta acabar en la DLQ sin motivo.
        if (ticket === null) {
          return ok({ status: 'skipped', reason: 'ticket_not_found' } as const);
        }
        if (ticket.assigneeId !== null) {
          // Alguien lo asignó a mano antes de que el job llegara: manda la persona.
          return ok({ status: 'skipped', reason: 'already_assigned' } as const);
        }

        const agentes = await this.members.agentsOf(input.tenantId);
        if (agentes.length === 0) {
          return ok({ status: 'skipped', reason: 'no_agents' } as const);
        }

        const elegido = agentes[(input.ticketNumber - 1) % agentes.length];

        const asignado = ticket.assignTo(elegido, now);
        if (asignado.isErr()) {
          // Cerrado antes de que corriera el job. Tampoco es un fallo.
          return ok({ status: 'skipped', reason: 'not_assignable' } as const);
        }

        await this.tickets.save(ticket);
        await this.audit.record({
          tenantId: input.tenantId,
          // Lo hizo el sistema, no una persona.
          actorId: SYSTEM_ACTOR_ID,
          action: 'ticket.assigned',
          entityType: 'ticket',
          entityId: ticket.id,
          metadata: { assigneeId: elegido, automatic: true },
          now,
        });
        await this.events.record(ticket);

        return ok({ status: 'assigned', assigneeId: elegido } as const);
      },
    );
  }
}
