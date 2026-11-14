import { Injectable } from '@nestjs/common';
import type { Prisma, SavedView as SavedViewRow } from '@prisma/client';
import { PrismaRepository } from '../../../../infrastructure/prisma/prisma.repository';
import { PrismaService } from '../../../../infrastructure/prisma/prisma.service';
import { SavedViewId, TenantId, UserId } from '../../domain/ids';
import { SavedViewRepository } from '../../domain/ports/saved-view.repository';
import { SavedView } from '../../domain/saved-view/saved-view.entity';
import {
  ViewFilters,
  parseViewFilters,
} from '../../domain/saved-view/view-filters';

/**
 * Los filtros se validaron al guardar; si algo los dejara inválidos (un UPDATE
 * a mano), la vista se lee sin filtros en vez de romper la barra lateral.
 */
const filtrosLeidos = (raw: unknown): ViewFilters => {
  const r = parseViewFilters(raw);
  return r.isOk() ? r.value : { version: 1 };
};

const toDomain = (row: SavedViewRow): SavedView =>
  SavedView.rehydrate({
    id: SavedViewId(row.id),
    tenantId: TenantId(row.tenantId),
    ownerId: row.ownerId === null ? null : UserId(row.ownerId),
    name: row.name,
    nameKey: row.nameKey,
    filters: filtrosLeidos(row.filters),
    createdBy: UserId(row.createdBy),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });

/** Vistas que `userId` puede ver: las compartidas y las suyas. */
const visibles = (
  tenantId: TenantId,
  userId: UserId,
): Prisma.SavedViewWhereInput => ({
  tenantId,
  OR: [{ ownerId: null }, { ownerId: userId }],
});

/**
 * Vistas guardadas (ADR-0033). Todo dentro de `runInTenant` (RLS); además, la
 * vista personal de otra persona no se lee ni se encuentra: es invisible.
 */
@Injectable()
export class PrismaSavedViewRepository
  extends PrismaRepository
  implements SavedViewRepository
{
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  listVisible(tenantId: TenantId, userId: UserId): Promise<SavedView[]> {
    return this.runInTenant(tenantId, async (tx) => {
      const rows = await tx.savedView.findMany({
        where: visibles(tenantId, userId),
        // Compartidas primero: `scope_key` 'shared' no se ordena bien frente a
        // un uuid, así que se ordena en memoria por `ownerId` nulo.
        orderBy: { nameKey: 'asc' },
      });
      return rows
        .map(toDomain)
        .sort((a, b) => Number(b.isShared) - Number(a.isShared));
    });
  }

  findVisible(
    tenantId: TenantId,
    userId: UserId,
    id: SavedViewId,
  ): Promise<SavedView | null> {
    return this.runInTenant(tenantId, async (tx) => {
      const row = await tx.savedView.findFirst({
        where: { ...visibles(tenantId, userId), id },
      });
      return row === null ? null : toDomain(row);
    });
  }

  existsName(
    tenantId: TenantId,
    scopeKey: string,
    nameKey: string,
    exceptId?: SavedViewId,
  ): Promise<boolean> {
    return this.runInTenant(tenantId, async (tx) => {
      const n = await tx.savedView.count({
        where: {
          tenantId,
          scopeKey,
          nameKey,
          ...(exceptId === undefined ? {} : { id: { not: exceptId } }),
        },
      });
      return n > 0;
    });
  }

  async insert(v: SavedView): Promise<void> {
    await this.runInTenant(v.tenantId, (tx) =>
      tx.savedView.create({
        data: {
          id: v.id,
          tenantId: v.tenantId,
          ownerId: v.ownerId,
          scopeKey: v.scopeKey,
          name: v.name,
          nameKey: v.nameKey,
          filters: v.filters as unknown as Prisma.InputJsonValue,
          createdBy: v.createdBy,
          createdAt: v.createdAt,
          updatedAt: v.updatedAt,
        },
      }),
    );
  }

  async update(v: SavedView): Promise<void> {
    await this.runInTenant(v.tenantId, (tx) =>
      tx.savedView.updateMany({
        where: { tenantId: v.tenantId, id: v.id },
        data: {
          name: v.name,
          nameKey: v.nameKey,
          filters: v.filters as unknown as Prisma.InputJsonValue,
          updatedAt: v.updatedAt,
        },
      }),
    );
  }

  remove(tenantId: TenantId, id: SavedViewId): Promise<boolean> {
    return this.runInTenant(tenantId, async (tx) => {
      const { count } = await tx.savedView.deleteMany({
        where: { tenantId, id },
      });
      return count > 0;
    });
  }
}
