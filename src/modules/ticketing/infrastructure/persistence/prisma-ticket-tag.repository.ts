import { Injectable } from '@nestjs/common';
import { PrismaRepository } from '../../../../infrastructure/prisma/prisma.repository';
import { PrismaService } from '../../../../infrastructure/prisma/prisma.service';
import { TagId, TenantId, TicketId } from '../../domain/ids';
import { TicketTagRepository } from '../../domain/ports/ticket-tag.repository';

/** Etiquetas de cada ticket (ADR-0031). */
@Injectable()
export class PrismaTicketTagRepository
  extends PrismaRepository
  implements TicketTagRepository
{
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  tagsOf(tenantId: TenantId, ticketId: TicketId): Promise<TagId[]> {
    return this.runInTenant(tenantId, async (tx) => {
      const rows = await tx.ticketTag.findMany({
        where: { tenantId, ticketId },
        select: { tagId: true },
      });
      return rows.map((r) => TagId(r.tagId));
    });
  }

  /**
   * Borrar y volver a insertar dentro de la MISMA transacción del caso de uso:
   * el conjunto es chico (máx. 10) y así no hay que calcular el diff dos veces.
   */
  async replace(
    tenantId: TenantId,
    ticketId: TicketId,
    tagIds: TagId[],
  ): Promise<void> {
    await this.runInTenant(tenantId, async (tx) => {
      await tx.ticketTag.deleteMany({ where: { tenantId, ticketId } });
      if (tagIds.length > 0) {
        await tx.ticketTag.createMany({
          data: tagIds.map((tagId) => ({ tenantId, ticketId, tagId })),
        });
      }
    });
  }
}
