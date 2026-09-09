import { Injectable } from '@nestjs/common';
import { PrismaRepository } from '../../../../infrastructure/prisma/prisma.repository';
import { PrismaService } from '../../../../infrastructure/prisma/prisma.service';
import { SlaTimerId, TenantId, TicketId } from '../../domain/ids';
import {
  SlaPolicyRepository,
  SlaTimerRepository,
} from '../../domain/ports/sla.repository';
import { SlaTarget } from '../../domain/sla/sla-policy';
import {
  SlaKind,
  SlaTimer,
  isSlaKind,
} from '../../domain/sla/sla-timer.entity';
import { TicketPriority, isTicketPriority } from '../../domain/ticket-status';

@Injectable()
export class PrismaSlaPolicyRepository
  extends PrismaRepository
  implements SlaPolicyRepository
{
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  /**
   * Devuelve SOLO lo que el tenant haya sobreescrito. Completar los huecos con
   * los valores por defecto es cosa del dominio (`resolvePolicy`): si se hiciera
   * aquí, la política por defecto viviría en un adapter de infraestructura.
   */
  async overridesOf(
    tenantId: TenantId,
  ): Promise<Partial<Record<TicketPriority, SlaTarget>>> {
    return this.runInTenant(tenantId, async (tx) => {
      const rows = await tx.slaPolicy.findMany({ where: { tenantId } });

      const overrides: Partial<Record<TicketPriority, SlaTarget>> = {};
      for (const row of rows) {
        const priority: string = row.priority;
        if (!isTicketPriority(priority)) {
          throw new Error(
            `Prioridad desconocida en sla_policies: "${priority}".`,
          );
        }
        overrides[priority] = {
          responseMinutes: row.responseMinutes,
          resolutionMinutes: row.resolutionMinutes,
        };
      }
      return overrides;
    });
  }

  async upsert(input: {
    tenantId: TenantId;
    priority: TicketPriority;
    target: SlaTarget;
    now: Date;
  }): Promise<void> {
    await this.runInTenant(input.tenantId, async (tx) => {
      await tx.slaPolicy.upsert({
        // La clave natural es (tenant, prioridad): el id sintético existe para
        // el ORM, pero quien manda es el par único del esquema.
        where: {
          tenantId_priority: {
            tenantId: input.tenantId,
            priority: input.priority,
          },
        },
        create: {
          tenantId: input.tenantId,
          priority: input.priority,
          responseMinutes: input.target.responseMinutes,
          resolutionMinutes: input.target.resolutionMinutes,
          // `updated_at` no lleva `@updatedAt`: la hora entra por el puerto
          // `Clock`, así que los tests pueden fijarla igual que en el resto.
          updatedAt: input.now,
        },
        update: {
          responseMinutes: input.target.responseMinutes,
          resolutionMinutes: input.target.resolutionMinutes,
          updatedAt: input.now,
        },
      });
    });
  }

  async remove(tenantId: TenantId, priority: TicketPriority): Promise<boolean> {
    return this.runInTenant(tenantId, async (tx) => {
      // `deleteMany` y no `delete`: borrar algo que no está no es un error aquí,
      // y `delete` lanzaría P2025 abortando la transacción del caso de uso.
      const { count } = await tx.slaPolicy.deleteMany({
        where: { tenantId, priority },
      });
      return count > 0;
    });
  }
}

@Injectable()
export class PrismaSlaTimerRepository
  extends PrismaRepository
  implements SlaTimerRepository
{
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  async save(timer: SlaTimer): Promise<void> {
    await this.runInTenant(timer.tenantId, async (tx) => {
      await tx.slaTimer.upsert({
        where: { id: timer.id },
        create: {
          id: timer.id,
          tenantId: timer.tenantId,
          ticketId: timer.ticketId,
          kind: timer.kind,
          startedAt: timer.startedAt,
          dueAt: timer.dueAt,
          stoppedAt: timer.stoppedAt,
          breachedAt: timer.breachedAt,
        },
        // `started_at` y `due_at` no se actualizan: el objetivo con el que un
        // reloj nació es inmutable (ver ADR-0020).
        update: {
          stoppedAt: timer.stoppedAt,
          breachedAt: timer.breachedAt,
        },
      });
    });
  }

  async findByTicket(
    tenantId: TenantId,
    ticketId: TicketId,
  ): Promise<SlaTimer[]> {
    return this.runInTenant(tenantId, async (tx) => {
      const rows = await tx.slaTimer.findMany({
        where: { tenantId, ticketId },
        orderBy: { kind: 'asc' },
      });
      return rows.map(toSlaTimer);
    });
  }

  async findRunning(
    tenantId: TenantId,
    ticketId: TicketId,
    kind: SlaKind,
  ): Promise<SlaTimer | null> {
    return this.runInTenant(tenantId, async (tx) => {
      const row = await tx.slaTimer.findFirst({
        where: {
          tenantId,
          ticketId,
          kind,
          stoppedAt: null,
          breachedAt: null,
        },
      });
      return row === null ? null : toSlaTimer(row);
    });
  }

  async findById(tenantId: TenantId, id: string): Promise<SlaTimer | null> {
    return this.runInTenant(tenantId, async (tx) => {
      const row = await tx.slaTimer.findFirst({ where: { id, tenantId } });
      return row === null ? null : toSlaTimer(row);
    });
  }
}

interface SlaTimerRow {
  id: string;
  tenantId: string;
  ticketId: string;
  kind: string;
  startedAt: Date;
  dueAt: Date;
  stoppedAt: Date | null;
  breachedAt: Date | null;
}

const toSlaTimer = (row: SlaTimerRow): SlaTimer => {
  const kind: string = row.kind;
  if (!isSlaKind(kind)) {
    throw new Error(`Tipo de SLA desconocido en base de datos: "${kind}".`);
  }
  return SlaTimer.rehydrate({
    id: SlaTimerId(row.id),
    tenantId: TenantId(row.tenantId),
    ticketId: TicketId(row.ticketId),
    kind,
    startedAt: row.startedAt,
    dueAt: row.dueAt,
    stoppedAt: row.stoppedAt,
    breachedAt: row.breachedAt,
  });
};
