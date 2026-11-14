import { Injectable } from '@nestjs/common';
import { PrismaRepository } from '../../../../infrastructure/prisma/prisma.repository';
import { PrismaService } from '../../../../infrastructure/prisma/prisma.service';
import { TenantId } from '../../domain/ids';
import {
  BusinessCalendarRepository,
  CalendarMode,
  StoredBusinessCalendar,
} from '../../domain/ports/business-calendar.repository';
import {
  BusinessWeek,
  CalendarException,
  DEFAULT_BUSINESS_HOURS,
  Weekday,
} from '../../domain/sla/business-calendar';

/** `DATE` de Postgres ↔ `YYYY-MM-DD`. Prisma lo trae como medianoche UTC. */
const aFecha = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);
const deFecha = (d: Date): string => d.toISOString().slice(0, 10);

const MODO = {
  business_hours: 'BUSINESS_HOURS',
  '24_7': 'TWENTY_FOUR_SEVEN',
} as const;

/**
 * Horario laboral (ADR-0034), todo dentro de `runInTenant` (RLS). Las fechas
 * de las excepciones son LOCALES de la organización y viajan como texto: nunca
 * pasan por la zona horaria del proceso.
 */
@Injectable()
export class PrismaBusinessCalendarRepository
  extends PrismaRepository
  implements BusinessCalendarRepository
{
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  configOf(tenantId: TenantId): Promise<StoredBusinessCalendar> {
    return this.runInTenant(tenantId, async (tx) => {
      const [fila, filas] = await Promise.all([
        tx.businessCalendar.findUnique({ where: { tenantId } }),
        tx.businessCalendarException.findMany({
          where: { tenantId },
          orderBy: { date: 'asc' },
        }),
      ]);
      const exceptions = filas.map((e) => ({
        id: e.id,
        date: deFecha(e.date),
        working: e.working,
        name: e.name,
      }));
      const week: BusinessWeek =
        fila === null
          ? {
              timeZone: DEFAULT_BUSINESS_HOURS.timeZone,
              weekdays: DEFAULT_BUSINESS_HOURS.weekdays,
              opensAtMinute: DEFAULT_BUSINESS_HOURS.opensAtMinute,
              closesAtMinute: DEFAULT_BUSINESS_HOURS.closesAtMinute,
            }
          : {
              timeZone: fila.timeZone,
              weekdays: fila.weekdays as Weekday[],
              opensAtMinute: fila.opensAtMinute,
              closesAtMinute: fila.closesAtMinute,
            };
      const mode: CalendarMode =
        fila?.mode === 'TWENTY_FOUR_SEVEN' ? '24_7' : 'business_hours';
      return {
        config:
          mode === '24_7'
            ? { mode: '24_7' }
            : {
                mode: 'business_hours',
                ...week,
                exceptions: exceptions.map(({ date, working, name }) => ({
                  date,
                  working,
                  name,
                })),
              },
        source: fila === null ? 'default' : 'organization',
        mode,
        week,
        exceptions,
      };
    });
  }

  saveWeek(input: {
    tenantId: TenantId;
    mode: CalendarMode;
    week: BusinessWeek;
    now: Date;
  }): Promise<void> {
    const datos = {
      mode: MODO[input.mode],
      timeZone: input.week.timeZone,
      weekdays: [...input.week.weekdays],
      opensAtMinute: input.week.opensAtMinute,
      closesAtMinute: input.week.closesAtMinute,
      updatedAt: input.now,
    };
    return this.runInTenant(input.tenantId, async (tx) => {
      await tx.businessCalendar.upsert({
        where: { tenantId: input.tenantId },
        create: { tenantId: input.tenantId, ...datos },
        update: datos,
      });
    });
  }

  addException(input: {
    tenantId: TenantId;
    id: string;
    exception: CalendarException;
    now: Date;
  }): Promise<'added' | 'duplicate'> {
    return this.addExceptions({
      tenantId: input.tenantId,
      items: [{ id: input.id, exception: input.exception }],
      now: input.now,
    }).then((n) => (n === 1 ? 'added' : 'duplicate'));
  }

  addExceptions(input: {
    tenantId: TenantId;
    items: { id: string; exception: CalendarException }[];
    now: Date;
  }): Promise<number> {
    if (input.items.length === 0) return Promise.resolve(0);
    // ON CONFLICT DO NOTHING (y no try/catch): dentro de una transacción de
    // Postgres un INSERT fallido la aborta entera (gotcha de la fase 5).
    return this.runInTenant(input.tenantId, async (tx) => {
      const r = await tx.businessCalendarException.createMany({
        data: input.items.map(({ id, exception }) => ({
          id,
          tenantId: input.tenantId,
          date: aFecha(exception.date),
          working: exception.working,
          name: exception.name,
          createdAt: input.now,
        })),
        skipDuplicates: true,
      });
      return r.count;
    });
  }

  removeException(tenantId: TenantId, id: string): Promise<boolean> {
    return this.runInTenant(tenantId, async (tx) => {
      const r = await tx.businessCalendarException.deleteMany({
        where: { tenantId, id },
      });
      return r.count > 0;
    });
  }
}
