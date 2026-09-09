import {
  Clock,
  Result,
  TransactionManager,
  err,
  ok,
} from '../../../shared-kernel';
import { Ticket } from '../domain/entities/ticket.entity';
import { TicketNotFoundError, TicketingError } from '../domain/errors';
import { TenantId, TicketId, UserId } from '../domain/ids';
import { TicketRepository } from '../domain/ports/ticket.repository';
import { TicketStatus } from '../domain/ticket-status';
import { AuditRecorder } from './audit-recorder';
import { runTransactional } from './transactional';

export interface ChangeTicketStatusInput {
  tenantId: TenantId;
  actorId: UserId;
  ticketId: TicketId;
  status: TicketStatus;
}

/**
 * Mueve un ticket por su máquina de estados (ADR-0015).
 *
 * El caso de uso NO sabe qué transiciones son legales: se lo pregunta a la
 * entidad. Si esa regla viviera aquí, el ticket creado desde el email entrante
 * (fase 5) o movido por el motor de SLA (fase 6) podría saltársela.
 */
export class ChangeTicketStatus {
  constructor(
    private readonly transactions: TransactionManager,
    private readonly tickets: TicketRepository,
    private readonly audit: AuditRecorder,
    private readonly clock: Clock,
  ) {}

  async execute(
    input: ChangeTicketStatusInput,
  ): Promise<Result<Ticket, TicketingError>> {
    const now = this.clock.now();

    return runTransactional(this.transactions, input.tenantId, async () => {
      const ticket = await this.tickets.findById(
        input.tenantId,
        input.ticketId,
      );
      if (ticket === null) {
        return err(new TicketNotFoundError());
      }

      const from = ticket.status;
      const applied = ticket.changeStatus(input.status, now);
      if (applied.isErr()) {
        return err(applied.error);
      }

      // Pedir el estado en el que ya estaba no cambió nada: no se guarda ni se
      // audita, para que el historial no se llene de entradas sin información.
      if (from === input.status) {
        return ok(ticket);
      }

      await this.tickets.save(ticket);
      await this.audit.record({
        tenantId: input.tenantId,
        actorId: input.actorId,
        action: 'ticket.status_changed',
        entityType: 'ticket',
        entityId: ticket.id,
        metadata: { from, to: input.status },
        now,
      });

      return ok(ticket);
    });
  }
}
