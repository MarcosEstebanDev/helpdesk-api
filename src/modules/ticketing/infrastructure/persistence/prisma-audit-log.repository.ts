import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaRepository } from '../../../../infrastructure/prisma/prisma.repository';
import { PrismaService } from '../../../../infrastructure/prisma/prisma.service';
import { AuditLog } from '../../domain/entities/audit-log.entity';
import { AuditLogRepository } from '../../domain/ports/audit-log.repository';

@Injectable()
export class PrismaAuditLogRepository
  extends PrismaRepository
  implements AuditLogRepository
{
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  async record(entry: AuditLog): Promise<void> {
    await this.runInTenant(entry.tenantId, async (tx) => {
      await tx.auditLog.create({
        data: {
          id: entry.id,
          tenantId: entry.tenantId,
          actorId: entry.actorId,
          action: entry.action,
          entityType: entry.entityType,
          entityId: entry.entityId,
          // `Prisma.DbNull` escribe NULL en la columna; `Prisma.JsonNull`
          // escribiría el valor JSON `null`, que es otra cosa y rompería el
          // "sin metadatos" al leerlo de vuelta.
          metadata:
            entry.metadata === null
              ? Prisma.DbNull
              : (entry.metadata as Prisma.InputJsonValue),
          occurredAt: entry.occurredAt,
        },
      });
    });
  }
}
