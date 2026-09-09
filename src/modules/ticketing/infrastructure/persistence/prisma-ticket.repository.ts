import { Injectable } from '@nestjs/common';
import { PrismaRepository } from '../../../../infrastructure/prisma/prisma.repository';
import { PrismaService } from '../../../../infrastructure/prisma/prisma.service';
import { Ticket } from '../../domain/entities/ticket.entity';
import { TenantId, TicketId } from '../../domain/ids';
import { TicketRepository } from '../../domain/ports/ticket.repository';
import { toTicket } from './ticketing.mappers';

@Injectable()
export class PrismaTicketRepository
  extends PrismaRepository
  implements TicketRepository
{
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  /**
   * Upsert: el caso de uso trabaja con el agregado y no distingue alta de
   * modificación. `update` no toca `id`, `tenant_id`, `number` ni `created_at`
   * porque son inmutables una vez creado el ticket; dejarlos fuera del UPDATE es
   * más barato que confiar en que nadie los cambie.
   */
  async save(ticket: Ticket): Promise<void> {
    await this.runInTenant(ticket.tenantId, async (tx) => {
      await tx.ticket.upsert({
        where: { id: ticket.id },
        create: {
          id: ticket.id,
          tenantId: ticket.tenantId,
          number: ticket.number,
          subject: ticket.subject,
          description: ticket.description,
          status: ticket.status,
          priority: ticket.priority,
          requesterId: ticket.requesterId,
          assigneeId: ticket.assigneeId,
          createdAt: ticket.createdAt,
          updatedAt: ticket.updatedAt,
          resolvedAt: ticket.resolvedAt,
          closedAt: ticket.closedAt,
        },
        update: {
          subject: ticket.subject,
          description: ticket.description,
          status: ticket.status,
          priority: ticket.priority,
          assigneeId: ticket.assigneeId,
          updatedAt: ticket.updatedAt,
          resolvedAt: ticket.resolvedAt,
          closedAt: ticket.closedAt,
        },
      });
    });
  }

  /**
   * `findFirst` con `tenantId` explícito y no `findUnique` por id: aunque RLS ya
   * acota al tenant, tener la condición también en el WHERE hace que el
   * aislamiento no dependa de una sola capa (defensa en profundidad, ADR-0010).
   */
  async findById(tenantId: TenantId, id: TicketId): Promise<Ticket | null> {
    return this.runInTenant(tenantId, async (tx) => {
      const row = await tx.ticket.findFirst({ where: { id, tenantId } });
      return row === null ? null : toTicket(row);
    });
  }
}
