import { AuditRecorder } from '../audit-recorder';
import {
  ACTOR,
  TENANT,
  fakeAuditLogRepository,
  fakeBusinessCalendars,
  fakeTransactions,
  fixedClock,
  sequentialIds,
} from '../ticketing.test-doubles';
import {
  AddCalendarException,
  GetBusinessHours,
  GetBusinessStatus,
  LoadNationalHolidays,
  RemoveCalendarException,
  UpdateBusinessHours,
} from './business-hours.use-cases';

// Sábado 14/11/2026 10:00 en Argentina (UTC-3).
const SABADO = new Date('2026-11-14T13:00:00.000Z');

const montar = (ahora = SABADO) => {
  const calendars = fakeBusinessCalendars();
  const auditLogs = fakeAuditLogRepository();
  const tx = fakeTransactions().manager;
  const ids = sequentialIds();
  const audit = new AuditRecorder(ids, auditLogs);
  const clock = fixedClock(ahora);
  return {
    calendars,
    auditLogs,
    get: new GetBusinessHours(calendars),
    update: new UpdateBusinessHours(tx, calendars, audit, clock),
    add: new AddCalendarException(tx, calendars, audit, clock, ids),
    remove: new RemoveCalendarException(tx, calendars, audit, clock),
    holidays: new LoadNationalHolidays(tx, calendars, audit, clock, ids),
    status: new GetBusinessStatus(calendars, clock),
  };
};

const SEMANA = {
  mode: 'business_hours' as const,
  timeZone: 'America/Argentina/Buenos_Aires',
  weekdays: [1, 2, 3, 4, 5],
  opensAt: '09:00',
  closesAt: '17:00',
};

describe('GetBusinessHours', () => {
  it('sin configurar muestra el horario por defecto en HH:MM', async () => {
    const vista = await montar().get.execute({ tenantId: TENANT });
    expect(vista).toEqual({
      mode: 'business_hours',
      timeZone: 'America/Argentina/Buenos_Aires',
      weekdays: [1, 2, 3, 4, 5],
      opensAt: '08:00',
      closesAt: '18:00',
      source: 'default',
      exceptions: [],
    });
  });
});

describe('UpdateBusinessHours', () => {
  it('guarda, devuelve la vista nueva y lo audita', async () => {
    const m = montar();
    const r = await m.update.execute({
      tenantId: TENANT,
      actorId: ACTOR,
      ...SEMANA,
    });

    expect(r.isOk() && r.value).toMatchObject({
      opensAt: '09:00',
      closesAt: '17:00',
      source: 'organization',
    });
    const entrada = m.auditLogs.entries.at(-1)!;
    expect(entrada.action).toBe('business_hours.changed');
    expect(entrada.entityId).toBe(TENANT);
    expect(entrada.metadata).toMatchObject({ change: 'week' });
  });

  it('rechaza un horario imposible sin guardar nada', async () => {
    const m = montar();
    const r = await m.update.execute({
      tenantId: TENANT,
      actorId: ACTOR,
      ...SEMANA,
      weekdays: [],
    });

    expect(r.isErr() && r.error.code).toBe('ticketing.invalid_business_hours');
    expect((await m.get.execute({ tenantId: TENANT })).source).toBe('default');
  });

  it('el modo 24/7 conserva la semana para cuando se vuelva', async () => {
    const m = montar();
    const r = await m.update.execute({
      tenantId: TENANT,
      actorId: ACTOR,
      ...SEMANA,
      mode: '24_7',
    });
    expect(r.isOk() && r.value).toMatchObject({
      mode: '24_7',
      opensAt: '09:00',
    });
  });
});

describe('AddCalendarException / RemoveCalendarException', () => {
  it('agrega una fecha y la segunda vez dice que ya existe', async () => {
    const m = montar();
    const navidad = {
      tenantId: TENANT,
      actorId: ACTOR,
      date: '2026-12-25',
      working: false,
      name: ' Navidad ',
    };

    const r = await m.add.execute(navidad);
    expect(r.isOk() && r.value).toMatchObject({
      date: '2026-12-25',
      name: 'Navidad',
    });
    const otra = await m.add.execute(navidad);
    expect(otra.isErr() && otra.error.code).toBe(
      'ticketing.duplicate_calendar_exception',
    );
  });

  it.each([
    ['fecha inexistente', { date: '2026-02-30' }],
    ['formato raro', { date: '25/12/2026' }],
    ['sin nombre', { name: '   ' }],
  ])('rechaza %s', async (_caso, cambio) => {
    const r = await montar().add.execute({
      tenantId: TENANT,
      actorId: ACTOR,
      date: '2026-12-25',
      working: false,
      name: 'Navidad',
      ...cambio,
    });
    expect(r.isErr() && r.error.code).toBe('ticketing.invalid_business_hours');
  });

  it('borrar algo que no existe es 404', async () => {
    const r = await montar().remove.execute({
      tenantId: TENANT,
      actorId: ACTOR,
      id: 'nada',
    });
    expect(r.isErr() && r.error.code).toBe(
      'ticketing.calendar_exception_not_found',
    );
  });
});

describe('LoadNationalHolidays', () => {
  it('agrega los del año y no pisa lo que el ADMIN ya cargó', async () => {
    const m = montar();
    await m.add.execute({
      tenantId: TENANT,
      actorId: ACTOR,
      date: '2026-12-25',
      working: true,
      name: 'Abrimos',
    });

    const r = await m.holidays.execute({
      tenantId: TENANT,
      actorId: ACTOR,
      year: 2026,
    });

    expect(r.isOk()).toBe(true);
    const { added, skipped } = r.isOk() ? r.value : { added: 0, skipped: 0 };
    expect(skipped).toBe(1);
    expect(added).toBeGreaterThan(10);
    expect(
      m.calendars.exceptions.find((e) => e.date === '2026-12-25')?.working,
    ).toBe(true);

    const otraVez = await m.holidays.execute({
      tenantId: TENANT,
      actorId: ACTOR,
      year: 2026,
    });
    expect(otraVez.isOk() && otraVez.value.added).toBe(0);
  });

  it('solo el año actual y el siguiente', async () => {
    const m = montar();
    expect(
      (
        await m.holidays.execute({
          tenantId: TENANT,
          actorId: ACTOR,
          year: 2027,
        })
      ).isOk(),
    ).toBe(true);
    const viejo = await m.holidays.execute({
      tenantId: TENANT,
      actorId: ACTOR,
      year: 2025,
    });
    expect(viejo.isErr() && viejo.error.code).toBe(
      'ticketing.invalid_business_hours',
    );
  });
});

describe('GetBusinessStatus', () => {
  it('un sábado dice cerrado y cuándo abre (lunes 08:00)', async () => {
    expect(await montar().status.execute({ tenantId: TENANT })).toEqual({
      open: false,
      nextOpening: new Date('2026-11-16T11:00:00.000Z'),
      timeZone: 'America/Argentina/Buenos_Aires',
    });
  });

  it('en horario dice abierto', async () => {
    const r = await montar(new Date('2026-11-13T15:00:00.000Z')).status.execute(
      { tenantId: TENANT },
    );
    expect(r).toMatchObject({ open: true, nextOpening: null });
  });
});
