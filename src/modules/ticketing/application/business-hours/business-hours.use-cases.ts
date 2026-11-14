import {
  Clock,
  IdGenerator,
  Result,
  TransactionManager,
  err,
  ok,
} from '../../../../shared-kernel';
import {
  CalendarExceptionNotFoundError,
  DuplicateCalendarExceptionError,
  InvalidBusinessHoursError,
  TicketingError,
} from '../../domain/errors';
import { TenantId, UserId } from '../../domain/ids';
import {
  BusinessCalendarRepository,
  CalendarMode,
  StoredBusinessCalendar,
  StoredCalendarException,
} from '../../domain/ports/business-calendar.repository';
import { nationalHolidays } from '../../domain/sla/argentina-holidays';
import {
  makeBusinessHours,
  minutosAHora,
  toBusinessCalendar,
} from '../../domain/sla/business-calendar';
import { AuditRecorder } from '../audit-recorder';
import { runTransactional } from '../transactional';

/**
 * Horario laboral de la organización (ADR-0034). Configurarlo es cosa del
 * ADMIN; el estado "abierto o cerrado y cuándo abre" lo puede pedir cualquiera
 * (el aviso al cliente) y NO trae nada más de la configuración.
 *
 * Cada cambio se audita en la MISMA transacción (ADR-0016), igual que la
 * política de SLA: el horario decide cuándo vence una promesa, y cambiarlo sin
 * rastro deja sin argumentos la discusión de un incumplimiento. Los relojes ya
 * en marcha NO se recalculan (decisión del diseño).
 */

export interface BusinessHoursView {
  mode: CalendarMode;
  timeZone: string;
  weekdays: number[];
  opensAt: string;
  closesAt: string;
  source: 'default' | 'organization';
  exceptions: StoredCalendarException[];
}

const vista = (c: StoredBusinessCalendar): BusinessHoursView => ({
  mode: c.mode,
  timeZone: c.week.timeZone,
  weekdays: [...c.week.weekdays],
  opensAt: minutosAHora(c.week.opensAtMinute),
  closesAt: minutosAHora(c.week.closesAtMinute),
  source: c.source,
  exceptions: c.exceptions,
});

/** La entidad auditada es el horario de ESTA organización: su id es el tenant. */
const ENTIDAD = 'BusinessCalendar';

export class GetBusinessHours {
  constructor(private readonly calendars: BusinessCalendarRepository) {}

  async execute(input: { tenantId: TenantId }): Promise<BusinessHoursView> {
    return vista(await this.calendars.configOf(input.tenantId));
  }
}

export class UpdateBusinessHours {
  constructor(
    private readonly transactions: TransactionManager,
    private readonly calendars: BusinessCalendarRepository,
    private readonly audit: AuditRecorder,
    private readonly clock: Clock,
  ) {}

  async execute(input: {
    tenantId: TenantId;
    actorId: UserId;
    mode: CalendarMode;
    timeZone: string;
    weekdays: number[];
    opensAt: string;
    closesAt: string;
  }): Promise<Result<BusinessHoursView, TicketingError>> {
    // Se valida la semana aunque el modo sea 24/7: se conserva para cuando se
    // vuelva al horario laboral, y guardarla rota sería una trampa diferida.
    const week = makeBusinessHours(input);
    if (week.isErr()) return err(week.error);

    return runTransactional<BusinessHoursView, TicketingError>(
      this.transactions,
      input.tenantId,
      async () => {
        const antes = vista(await this.calendars.configOf(input.tenantId));
        const now = this.clock.now();
        await this.calendars.saveWeek({
          tenantId: input.tenantId,
          mode: input.mode,
          week: week.value,
          now,
        });
        const despues = vista(await this.calendars.configOf(input.tenantId));
        await this.audit.record({
          tenantId: input.tenantId,
          actorId: input.actorId,
          action: 'business_hours.changed',
          entityType: ENTIDAD,
          entityId: input.tenantId,
          metadata: {
            change: 'week',
            before: { ...antes, exceptions: undefined },
            after: { ...despues, exceptions: undefined },
          },
          now,
        });
        return ok(despues);
      },
    );
  }
}

const FECHA = /^(\d{4})-(\d{2})-(\d{2})$/;
const fechaValida = (s: string): boolean => {
  const m = FECHA.exec(s);
  if (m === null) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === s;
};
const NOMBRE_MAX = 120;

export class AddCalendarException {
  constructor(
    private readonly transactions: TransactionManager,
    private readonly calendars: BusinessCalendarRepository,
    private readonly audit: AuditRecorder,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async execute(input: {
    tenantId: TenantId;
    actorId: UserId;
    date: string;
    working: boolean;
    name: string;
  }): Promise<Result<StoredCalendarException, TicketingError>> {
    const name = input.name.trim();
    if (!fechaValida(input.date)) {
      return err(
        new InvalidBusinessHoursError(
          'La fecha va como AAAA-MM-DD y tiene que existir.',
        ),
      );
    }
    if (name.length === 0 || name.length > NOMBRE_MAX) {
      return err(
        new InvalidBusinessHoursError(
          `El nombre va de 1 a ${NOMBRE_MAX} caracteres.`,
        ),
      );
    }
    const exception = {
      id: this.ids.uuid(),
      date: input.date,
      working: input.working,
      name,
    };

    return runTransactional<StoredCalendarException, TicketingError>(
      this.transactions,
      input.tenantId,
      async () => {
        const now = this.clock.now();
        const r = await this.calendars.addException({
          tenantId: input.tenantId,
          id: exception.id,
          exception: { date: exception.date, working: exception.working, name },
          now,
        });
        if (r === 'duplicate')
          return err(new DuplicateCalendarExceptionError(input.date));
        await this.audit.record({
          tenantId: input.tenantId,
          actorId: input.actorId,
          action: 'business_hours.changed',
          entityType: ENTIDAD,
          entityId: input.tenantId,
          metadata: { change: 'exception_added', exception },
          now,
        });
        return ok(exception);
      },
    );
  }
}

export class RemoveCalendarException {
  constructor(
    private readonly transactions: TransactionManager,
    private readonly calendars: BusinessCalendarRepository,
    private readonly audit: AuditRecorder,
    private readonly clock: Clock,
  ) {}

  async execute(input: {
    tenantId: TenantId;
    actorId: UserId;
    id: string;
  }): Promise<Result<void, TicketingError>> {
    return runTransactional<void, TicketingError>(
      this.transactions,
      input.tenantId,
      async () => {
        const actual = (
          await this.calendars.configOf(input.tenantId)
        ).exceptions.find((e) => e.id === input.id);
        if (
          actual === undefined ||
          !(await this.calendars.removeException(input.tenantId, input.id))
        ) {
          return err(new CalendarExceptionNotFoundError());
        }
        const now = this.clock.now();
        await this.audit.record({
          tenantId: input.tenantId,
          actorId: input.actorId,
          action: 'business_hours.changed',
          entityType: ENTIDAD,
          entityId: input.tenantId,
          metadata: { change: 'exception_removed', exception: actual },
          now,
        });
        return ok(undefined);
      },
    );
  }
}

/**
 * Precarga los feriados nacionales de un año: el actual o el siguiente (en
 * noviembre ya hace falta el año que viene). Respeta lo que el ADMIN cargó a
 * mano en esas fechas e informa cuántos agregó y cuántos ya estaban.
 */
export class LoadNationalHolidays {
  constructor(
    private readonly transactions: TransactionManager,
    private readonly calendars: BusinessCalendarRepository,
    private readonly audit: AuditRecorder,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async execute(input: {
    tenantId: TenantId;
    actorId: UserId;
    year: number;
  }): Promise<Result<{ added: number; skipped: number }, TicketingError>> {
    const actual = this.clock.now().getUTCFullYear();
    const lista = nationalHolidays(input.year);
    if (input.year !== actual && input.year !== actual + 1) {
      return err(
        new InvalidBusinessHoursError(
          `Solo se pueden cargar los feriados de ${actual} y ${actual + 1}.`,
        ),
      );
    }
    if (lista === null) {
      return err(
        new InvalidBusinessHoursError(
          `Todavía no hay feriados cargados para ${input.year}.`,
        ),
      );
    }

    return runTransactional<{ added: number; skipped: number }, TicketingError>(
      this.transactions,
      input.tenantId,
      async () => {
        const now = this.clock.now();
        const added = await this.calendars.addExceptions({
          tenantId: input.tenantId,
          items: lista.map((exception) => ({ id: this.ids.uuid(), exception })),
          now,
        });
        const resultado = { added, skipped: lista.length - added };
        if (added > 0) {
          await this.audit.record({
            tenantId: input.tenantId,
            actorId: input.actorId,
            action: 'business_hours.changed',
            entityType: ENTIDAD,
            entityId: input.tenantId,
            metadata: {
              change: 'holidays_loaded',
              year: input.year,
              ...resultado,
            },
            now,
          });
        }
        return ok(resultado);
      },
    );
  }
}

/**
 * Lo único que ve el cliente del horario: si se está atendiendo y cuándo se
 * abre. La zona viaja para que el front muestre la hora de la ORGANIZACIÓN,
 * no la del navegador del cliente.
 */
export class GetBusinessStatus {
  constructor(
    private readonly calendars: BusinessCalendarRepository,
    private readonly clock: Clock,
  ) {}

  async execute(input: {
    tenantId: TenantId;
  }): Promise<{ open: boolean; nextOpening: Date | null; timeZone: string }> {
    const c = await this.calendars.configOf(input.tenantId);
    const cal = toBusinessCalendar(c.config);
    const now = this.clock.now();
    return {
      open: cal.isOpenAt(now),
      nextOpening: cal.nextOpeningAfter(now),
      timeZone: c.week.timeZone,
    };
  }
}
