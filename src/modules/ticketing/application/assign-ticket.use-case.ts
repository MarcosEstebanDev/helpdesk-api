import {
  Clock,
  Result,
  TransactionManager,
  err,
  ok,
} from '../../../shared-kernel';
import { Ticket } from '../domain/entities/ticket.entity';
import {
  AssigneeNotFoundError,
  TicketNotFoundError,
  TicketingError,
} from '../domain/errors';
import { TenantId, TicketId, UserId } from '../domain/ids';
import { MemberDirectory } from '../domain/ports/member.directory';
import { TicketRepository } from '../domain/ports/ticket.repository';
import { AuditRecorder } from './audit-recorder';
import { runTransactional } from './transactional';

export interface AssignTicketInput {
  tenantId: TenantId;
  actorId: UserId;
  ticketId: TicketId;
  /** `null` para devolver el ticket a la cola. */
  assigneeId: UserId | null;
}

/**
 * Asigna (o desasigna) un ticket.
 *
 * Comprobar la pertenencia del destinatario es la parte interesante: sin ella,
 * un ADMIN podría asignar tickets a un `userId` cualquiera. RLS ya impediría que
 * eso cruzara tenants —la consulta no vería al usuario ajeno—, pero el error
 * llegaría como una violación de clave foránea en vez de como un mensaje
 * entendible. La comprobación explícita convierte un 500 en un 404 con sentido.
 */
export class AssignTicket {
  constructor(
    private readonly transactions: TransactionManager,
    private readonly tickets: TicketRepository,
    private readonly members: MemberDirectory,
    private readonly audit: AuditRecorder,
    private readonly clock: Clock,
  ) {}

  async execute(
    input: AssignTicketInput,
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

      if (input.assigneeId !== null) {
        const isMember = await this.members.isMember(
          input.tenantId,
          input.assigneeId,
        );
        if (!isMember) {
          return err(new AssigneeNotFoundError());
        }
      }

      const applied =
        input.assigneeId === null
          ? ticket.unassign(now)
          : ticket.assignTo(input.assigneeId, now);
      if (applied.isErr()) {
        return err(applied.error);
      }

      await this.tickets.save(ticket);
      await this.audit.record({
        tenantId: input.tenantId,
        actorId: input.actorId,
        action:
          input.assigneeId === null ? 'ticket.unassigned' : 'ticket.assigned',
        entityType: 'ticket',
        entityId: ticket.id,
        metadata: { assigneeId: input.assigneeId },
        now,
      });

      return ok(ticket);
    });
  }
}
