import { Injectable } from '@nestjs/common';
import type { Tag as TagRow } from '@prisma/client';
import { PrismaRepository } from '../../../../infrastructure/prisma/prisma.repository';
import { PrismaService } from '../../../../infrastructure/prisma/prisma.service';
import { TagId, TenantId } from '../../domain/ids';
import { TagRepository } from '../../domain/ports/tag.repository';
import { Tag, isTagColor } from '../../domain/tag/tag.entity';

const toDomain = (row: TagRow): Tag =>
  Tag.rehydrate({
    id: TagId(row.id),
    tenantId: TenantId(row.tenantId),
    name: row.name,
    nameKey: row.nameKey,
    // La columna es TEXT: un valor fuera de la paleta solo puede venir de un
    // UPDATE a mano. Se muestra gris en vez de romper la pantalla.
    color: isTagColor(row.color) ? row.color : 'gray',
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });

/**
 * Catálogo de etiquetas (ADR-0031). Todo dentro de `runInTenant`: con RLS, un
 * id de otra organización simplemente no existe. Borrar una etiqueta la quita
 * de sus tickets por la FK en cascada de `ticket_tags`.
 */
@Injectable()
export class PrismaTagRepository
  extends PrismaRepository
  implements TagRepository
{
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  list(tenantId: TenantId): Promise<Tag[]> {
    return this.runInTenant(tenantId, async (tx) => {
      const rows = await tx.tag.findMany({
        where: { tenantId },
        orderBy: { nameKey: 'asc' },
      });
      return rows.map(toDomain);
    });
  }

  findById(tenantId: TenantId, id: TagId): Promise<Tag | null> {
    return this.runInTenant(tenantId, async (tx) => {
      const row = await tx.tag.findFirst({ where: { tenantId, id } });
      return row === null ? null : toDomain(row);
    });
  }

  findByIds(tenantId: TenantId, ids: TagId[]): Promise<Tag[]> {
    if (ids.length === 0) return Promise.resolve([]);
    return this.runInTenant(tenantId, async (tx) => {
      const rows = await tx.tag.findMany({
        where: { tenantId, id: { in: ids } },
      });
      return rows.map(toDomain);
    });
  }

  existsNameKey(
    tenantId: TenantId,
    nameKey: string,
    exceptId?: TagId,
  ): Promise<boolean> {
    return this.runInTenant(tenantId, async (tx) => {
      const n = await tx.tag.count({
        where: {
          tenantId,
          nameKey,
          ...(exceptId === undefined ? {} : { id: { not: exceptId } }),
        },
      });
      return n > 0;
    });
  }

  async insert(tag: Tag): Promise<void> {
    await this.runInTenant(tag.tenantId, (tx) =>
      tx.tag.create({
        data: {
          id: tag.id,
          tenantId: tag.tenantId,
          name: tag.name,
          nameKey: tag.nameKey,
          color: tag.color,
          createdAt: tag.createdAt,
          updatedAt: tag.updatedAt,
        },
      }),
    );
  }

  async update(tag: Tag): Promise<void> {
    await this.runInTenant(tag.tenantId, (tx) =>
      tx.tag.updateMany({
        where: { tenantId: tag.tenantId, id: tag.id },
        data: {
          name: tag.name,
          nameKey: tag.nameKey,
          color: tag.color,
          updatedAt: tag.updatedAt,
        },
      }),
    );
  }

  remove(tenantId: TenantId, id: TagId): Promise<boolean> {
    return this.runInTenant(tenantId, async (tx) => {
      const { count } = await tx.tag.deleteMany({ where: { tenantId, id } });
      return count > 0;
    });
  }
}
