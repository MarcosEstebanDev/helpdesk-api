import {
  Clock,
  IdGenerator,
  Result,
  TransactionManager,
  ok,
} from '../../../shared-kernel';
import { Ticket } from '../domain/entities/ticket.entity';
import { TicketingError } from '../domain/errors';
import { TenantId, TicketId, UserId } from '../domain/ids';
import { TicketNumberGenerator } from '../domain/ports/ticket-number.generator';
import { TicketRepository } from '../domain/ports/ticket.repository';
import { TicketPriority } from '../domain/ticket-status';
import { AuditRecorder } from './audit-recorder';
import { runTransactional } from './transactional';

export interface CreateTicketInput {
  tenantId: TenantId;
  /** Quien crea el ticket; sale del JWT, nunca del cuerpo de la petición. */
  actorId: UserId;
  subject: string;
  description: string;
  priority: TicketPriority;
}

/**
 * Alta de un ticket.
 *
 * Las tres escrituras —reservar el número, insertar el ticket y registrar la
 * auditoría— van en UNA transacción (ADR-0016). Si algo falla, no queda ni un
 * número consumido ni un ticket sin rastro.
 */
export class CreateTicket {
  constructor(
    private readonly transactions: TransactionManager,
    private readonly tickets: TicketRepository,
    private readonly numbers: TicketNumberGenerator,
    private readonly audit: AuditRecorder,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async execute(
    input: CreateTicketInput,
  ): Promise<Result<Ticket, TicketingError>> {
    const now = this.clock.now();

    return runTransactional(this.transactions, input.tenantId, async () => {
      // Dentro de la transacción: si la validación de abajo falla, el número
      // vuelve atrás con el rollback y no deja hueco en la numeración.
      const number = await this.numbers.next(input.tenantId);

      const created = Ticket.open({
        id: TicketId(this.ids.uuid()),
        tenantId: input.tenantId,
        number,
        subject: input.subject,
        description: input.description,
        priority: input.priority,
        requesterId: input.actorId,
        now,
      });
      if (created.isErr()) {
        return created;
      }

      const ticket = created.value;
      await this.tickets.save(ticket);
      await this.audit.record({
        tenantId: input.tenantId,
        actorId: input.actorId,
        action: 'ticket.created',
        entityType: 'ticket',
        entityId: ticket.id,
        metadata: { number: ticket.number, priority: ticket.priority },
        now,
      });

      return ok(ticket);
    });
  }
}
