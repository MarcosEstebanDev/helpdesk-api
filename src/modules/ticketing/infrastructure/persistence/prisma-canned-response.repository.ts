import { Injectable } from '@nestjs/common';
import type { CannedResponse as CannedResponseRow } from '@prisma/client';
import { PrismaRepository } from '../../../../infrastructure/prisma/prisma.repository';
import { PrismaService } from '../../../../infrastructure/prisma/prisma.service';
import { CannedResponse } from '../../domain/canned-response/canned-response.entity';
import { CannedResponseId, TenantId, UserId } from '../../domain/ids';
import { CannedResponseRepository } from '../../domain/ports/canned-response.repository';

const toDomain = (row: CannedResponseRow): CannedResponse =>
  CannedResponse.rehydrate({
    id: CannedResponseId(row.id),
    tenantId: TenantId(row.tenantId),
    title: row.title,
    titleKey: row.titleKey,
    body: row.body,
    createdBy: UserId(row.createdBy),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });

/**
 * Respuestas predefinidas (ADR-0030). Cada operación corre dentro de
 * `runInTenant`, así que RLS hace invisible lo de otra organización: un id
 * ajeno simplemente "no existe".
 *
 * No captura P2002 (título duplicado): una violación de unicidad aborta la
 * transacción ENTERA en Postgres, así que aquí no hay nada que recuperar. Lo
 * traduce el borde HTTP a 409.
 */
@Injectable()
export class PrismaCannedResponseRepository
  extends PrismaRepository
  implements CannedResponseRepository
{
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  list(tenantId: TenantId): Promise<CannedResponse[]> {
    return this.runInTenant(tenantId, async (tx) => {
      const rows = await tx.cannedResponse.findMany({
        where: { tenantId },
        orderBy: { titleKey: 'asc' },
      });
      return rows.map(toDomain);
    });
  }

  findById(
    tenantId: TenantId,
    id: CannedResponseId,
  ): Promise<CannedResponse | null> {
    return this.runInTenant(tenantId, async (tx) => {
      const row = await tx.cannedResponse.findFirst({
        where: { tenantId, id },
      });
      return row === null ? null : toDomain(row);
    });
  }

  existsTitleKey(
    tenantId: TenantId,
    titleKey: string,
    exceptId?: CannedResponseId,
  ): Promise<boolean> {
    return this.runInTenant(tenantId, async (tx) => {
      const n = await tx.cannedResponse.count({
        where: {
          tenantId,
          titleKey,
          ...(exceptId === undefined ? {} : { id: { not: exceptId } }),
        },
      });
      return n > 0;
    });
  }

  async insert(r: CannedResponse): Promise<void> {
    await this.runInTenant(r.tenantId, (tx) =>
      tx.cannedResponse.create({
        data: {
          id: r.id,
          tenantId: r.tenantId,
          title: r.title,
          titleKey: r.titleKey,
          body: r.body,
          createdBy: r.createdBy,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
        },
      }),
    );
  }

  async update(r: CannedResponse): Promise<void> {
    await this.runInTenant(r.tenantId, (tx) =>
      tx.cannedResponse.updateMany({
        where: { tenantId: r.tenantId, id: r.id },
        data: {
          title: r.title,
          titleKey: r.titleKey,
          body: r.body,
          updatedAt: r.updatedAt,
        },
      }),
    );
  }

  remove(tenantId: TenantId, id: CannedResponseId): Promise<boolean> {
    return this.runInTenant(tenantId, async (tx) => {
      const { count } = await tx.cannedResponse.deleteMany({
        where: { tenantId, id },
      });
      return count > 0;
    });
  }
}
