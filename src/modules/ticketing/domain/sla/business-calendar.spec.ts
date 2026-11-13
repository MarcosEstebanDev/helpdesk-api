import {
  BusinessCalendarConfig,
  DEFAULT_BUSINESS_HOURS,
  MAX_SEARCH_DAYS,
  makeBusinessHours,
  toBusinessCalendar,
} from './business-calendar';
import { CALENDAR_24_7 } from './sla-calendar';

// Instantes en UTC. Argentina es UTC-3 todo el año. 2026-11-13 es viernes.
const z = (iso: string) => new Date(`${iso}Z`);
const VIE_17 = z('2026-11-13T20:00:00');

const ar = (
  extra: Partial<
    Extract<BusinessCalendarConfig, { mode: 'business_hours' }>
  > = {},
) => toBusinessCalendar({ ...DEFAULT_BUSINESS_HOURS, ...extra });

describe('BusinessCalendar (horario laboral)', () => {
  describe('dueAt', () => {
    it('lo que no entra el viernes sigue el lunes: vie 17:00 + 4 h = lun 11:00', () => {
      expect(ar().dueAt(VIE_17, 240)).toEqual(z('2026-11-16T14:00:00'));
    });

    it('con la oficina cerrada el reloj arranca en la próxima apertura', () => {
      // Viernes 22:00 y sábado 10:00: los dos arrancan el lunes 08:00.
      expect(ar().dueAt(z('2026-11-14T01:00:00'), 60)).toEqual(
        z('2026-11-16T12:00:00'),
      );
      expect(ar().dueAt(z('2026-11-14T13:00:00'), 60)).toEqual(
        z('2026-11-16T12:00:00'),
      );
    });

    it('si vence justo al cierre, vence ese día y no el siguiente a las 8', () => {
      expect(ar().dueAt(VIE_17, 60)).toEqual(z('2026-11-13T21:00:00'));
    });

    it('un feriado pisa la semana tipo aunque caiga en día hábil', () => {
      const cal = ar({
        exceptions: [{ date: '2026-11-16', working: false, name: 'Feriado' }],
      });
      expect(cal.dueAt(VIE_17, 240)).toEqual(z('2026-11-17T14:00:00'));
    });

    it('un sábado marcado hábil usa la franja de la semana tipo', () => {
      const cal = ar({
        exceptions: [
          { date: '2026-11-14', working: true, name: 'Cierre de mes' },
        ],
      });
      expect(cal.dueAt(VIE_17, 240)).toEqual(z('2026-11-14T14:00:00'));
    });

    it('cuenta en la zona del calendario, no en la del proceso', () => {
      // Madrid en noviembre es UTC+1: viernes 17:00 CET = 16:00Z.
      const cal = ar({ timeZone: 'Europe/Madrid' });
      expect(cal.dueAt(z('2026-11-13T16:00:00'), 60)).toEqual(
        z('2026-11-13T17:00:00'),
      );
    });

    it('sin días hábiles alcanzables falla fuerte en vez de colgarse', () => {
      const lunes: { date: string; working: boolean; name: string }[] = [];
      const d = new Date(Date.UTC(2026, 10, 16));
      for (let i = 0; i < MAX_SEARCH_DAYS + 7; i += 7) {
        lunes.push({
          date: new Date(d.getTime() + i * 86_400_000)
            .toISOString()
            .slice(0, 10),
          working: false,
          name: 'cerrado',
        });
      }
      const cal = ar({ weekdays: [1], exceptions: lunes });
      expect(() => cal.dueAt(VIE_17, 60)).toThrow(/sin días hábiles/);
    });
  });

  describe('workingMinutesBetween', () => {
    it('cuenta solo los minutos hábiles', () => {
      expect(ar().workingMinutesBetween(VIE_17, z('2026-11-16T14:00:00'))).toBe(
        240,
      );
    });

    it('es 0 si el final no es posterior', () => {
      expect(ar().workingMinutesBetween(VIE_17, VIE_17)).toBe(0);
      expect(ar().workingMinutesBetween(VIE_17, z('2026-11-13T19:00:00'))).toBe(
        0,
      );
    });

    it('es la inversa de dueAt', () => {
      const desde = z('2026-11-12T15:30:00'); // jueves 12:30
      const hasta = z('2026-11-17T13:15:00'); // martes 10:15
      const cal = ar();
      expect(cal.dueAt(desde, cal.workingMinutesBetween(desde, hasta))).toEqual(
        hasta,
      );
    });
  });

  describe('apertura', () => {
    it('sabe si está abierto', () => {
      expect(ar().isOpenAt(VIE_17)).toBe(true);
      expect(ar().isOpenAt(z('2026-11-14T13:00:00'))).toBe(false);
      expect(ar().isOpenAt(z('2026-11-13T21:00:00'))).toBe(false); // 18:00 ya cerró
    });

    it('dice cuándo abre, y null si ya está abierto', () => {
      expect(ar().nextOpeningAfter(z('2026-11-14T13:00:00'))).toEqual(
        z('2026-11-16T11:00:00'),
      );
      expect(ar().nextOpeningAfter(VIE_17)).toBeNull();
    });
  });

  it('en modo 24/7 es el calendario de siempre', () => {
    expect(toBusinessCalendar({ mode: '24_7' })).toBe(CALENDAR_24_7);
    expect(CALENDAR_24_7.isOpenAt(VIE_17)).toBe(true);
    expect(CALENDAR_24_7.nextOpeningAfter(VIE_17)).toBeNull();
  });
});

describe('makeBusinessHours', () => {
  const base = {
    timeZone: 'America/Argentina/Buenos_Aires',
    weekdays: [1, 2, 3, 4, 5],
    opensAt: '08:00',
    closesAt: '18:00',
  };

  it('acepta los valores por defecto y los pasa a minutos', () => {
    const r = makeBusinessHours(base);
    expect(r.isOk() && r.value).toEqual({
      timeZone: base.timeZone,
      weekdays: [1, 2, 3, 4, 5],
      opensAtMinute: 480,
      closesAtMinute: 1080,
    });
  });

  it.each([
    ['sin días', { weekdays: [] }],
    ['cierre antes que apertura', { opensAt: '18:00', closesAt: '08:00' }],
    ['hora imposible', { opensAt: '25:00' }],
    ['día inexistente', { weekdays: [0] }],
    ['zona inexistente', { timeZone: 'Marte/Olimpo' }],
  ])('rechaza %s', (_caso, cambio) => {
    const r = makeBusinessHours({ ...base, ...cambio });
    expect(r.isErr() && r.error.code).toBe('ticketing.invalid_business_hours');
  });
});
