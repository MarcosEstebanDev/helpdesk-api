import { Result, err, ok } from '../../../../shared-kernel';
import { InvalidBusinessHoursError } from '../errors';
import { BusinessCalendar, CALENDAR_24_7 } from './sla-calendar';

export type { BusinessCalendar } from './sla-calendar';

/** Día de la semana ISO: 1 = lunes … 7 = domingo. */
export type Weekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

/** Una fecha que pisa la semana tipo: feriado (no hábil) o día hábil extra. */
export interface CalendarException {
  /** Fecha LOCAL de la organización, `YYYY-MM-DD`. */
  date: string;
  working: boolean;
  name: string;
}

export interface BusinessWeek {
  timeZone: string;
  weekdays: readonly Weekday[];
  /** Minutos desde las 00:00 locales. */
  opensAtMinute: number;
  closesAtMinute: number;
}

export type BusinessCalendarConfig =
  | { mode: '24_7' }
  | ({
      mode: 'business_hours';
      exceptions: readonly CalendarException[];
    } & BusinessWeek);

/** Lo que tiene una organización que nunca configuró nada (decisión del usuario). */
export const DEFAULT_BUSINESS_HOURS: Extract<
  BusinessCalendarConfig,
  { mode: 'business_hours' }
> = {
  mode: 'business_hours',
  timeZone: 'America/Argentina/Buenos_Aires',
  weekdays: [1, 2, 3, 4, 5],
  opensAtMinute: 8 * 60,
  closesAtMinute: 18 * 60,
  exceptions: [],
};

/**
 * Hasta dónde se busca un día hábil. Dos años sobra para cualquier SLA real
 * (`SLA_MAX_MINUTES` es un año de minutos); pasarlo significa un calendario
 * imposible, y se falla fuerte en vez de quedar buscando para siempre.
 */
export const MAX_SEARCH_DAYS = 730;

const MS_DIA = 86_400_000;
const MS_MIN = 60_000;

interface FechaLocal {
  y: number;
  m: number; // 1-12
  d: number;
}

const formateadores = new Map<string, Intl.DateTimeFormat>();
const formateador = (timeZone: string): Intl.DateTimeFormat => {
  let f = formateadores.get(timeZone);
  if (f === undefined) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formateadores.set(timeZone, f);
  }
  return f;
};

/** Fecha y hora locales de un instante en la zona dada. */
const partesLocales = (instante: number, timeZone: string) => {
  const p: Record<string, number> = {};
  for (const parte of formateador(timeZone).formatToParts(instante)) {
    if (parte.type !== 'literal') p[parte.type] = Number(parte.value);
  }
  return p as {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
    second: number;
  };
};

/** Diferencia (ms) entre la hora local de la zona y UTC en ese instante. */
const desfase = (instante: number, timeZone: string): number => {
  const p = partesLocales(instante, timeZone);
  const comoUtc = Date.UTC(
    p.year,
    p.month - 1,
    p.day,
    p.hour,
    p.minute,
    p.second,
  );
  return comoUtc - Math.floor(instante / 1000) * 1000;
};

/**
 * Instante de "fecha local + minuto del día" en la zona. Se calcula el desfase
 * DE ESE instante (dos pasadas), no se supone fijo: así sirve también para
 * zonas con horario de verano.
 */
const instanteLocal = (
  f: FechaLocal,
  minuto: number,
  timeZone: string,
): number => {
  const ingenuo = Date.UTC(f.y, f.m - 1, f.d) + minuto * MS_MIN;
  const primero = ingenuo - desfase(ingenuo, timeZone);
  return ingenuo - desfase(primero, timeZone);
};

const fechaDe = (instante: number, timeZone: string): FechaLocal => {
  const p = partesLocales(instante, timeZone);
  return { y: p.year, m: p.month, d: p.day };
};

const sumarDias = (f: FechaLocal, dias: number): FechaLocal => {
  const t = new Date(Date.UTC(f.y, f.m - 1, f.d) + dias * MS_DIA);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
};

const iso = (f: FechaLocal): string =>
  `${f.y}-${String(f.m).padStart(2, '0')}-${String(f.d).padStart(2, '0')}`;

const diaIso = (f: FechaLocal): Weekday => {
  const dow = new Date(Date.UTC(f.y, f.m - 1, f.d)).getUTCDay();
  return (dow === 0 ? 7 : dow) as Weekday;
};

const anterior = (a: FechaLocal, b: FechaLocal): boolean => iso(a) <= iso(b);

/**
 * Calendario de días hábiles de UNA organización (ADR-0034): semana tipo +
 * excepciones por fecha, en su zona horaria. El reloj del SLA solo avanza
 * dentro de `[apertura, cierre)` de los días hábiles.
 */
const calendarioHabil = (
  config: Extract<BusinessCalendarConfig, { mode: 'business_hours' }>,
): BusinessCalendar => {
  const { timeZone, opensAtMinute, closesAtMinute } = config;
  const semana = new Set(config.weekdays);
  const excepciones = new Map(
    config.exceptions.map((e) => [e.date, e.working]),
  );

  const esHabil = (f: FechaLocal): boolean =>
    excepciones.get(iso(f)) ?? semana.has(diaIso(f));
  const franja = (f: FechaLocal): [number, number] => [
    instanteLocal(f, opensAtMinute, timeZone),
    instanteLocal(f, closesAtMinute, timeZone),
  ];
  const imposible = (): Error =>
    new Error(
      `Calendario sin días hábiles en los próximos ${MAX_SEARCH_DAYS} días (zona ${timeZone}).`,
    );
  const abierto = (at: Date): boolean => {
    const t = at.getTime();
    const dia = fechaDe(t, timeZone);
    if (!esHabil(dia)) return false;
    const [abre, cierra] = franja(dia);
    return t >= abre && t < cierra;
  };

  return {
    name: `horario ${timeZone}`,

    dueAt(from, minutes) {
      let restante = minutes * MS_MIN;
      const desde = from.getTime();
      const inicio = fechaDe(desde, timeZone);
      for (let i = 0; i <= MAX_SEARCH_DAYS; i++) {
        const dia = sumarDias(inicio, i);
        if (!esHabil(dia)) continue;
        const [abre, cierra] = franja(dia);
        const arranque = Math.max(desde, abre);
        if (arranque >= cierra) continue;
        const disponible = cierra - arranque;
        if (restante <= disponible) return new Date(arranque + restante);
        restante -= disponible;
      }
      throw imposible();
    },

    workingMinutesBetween(from, to) {
      const desde = from.getTime();
      const hasta = to.getTime();
      if (hasta <= desde) return 0;
      const ultimo = fechaDe(hasta, timeZone);
      let total = 0;
      for (
        let dia = fechaDe(desde, timeZone);
        anterior(dia, ultimo);
        dia = sumarDias(dia, 1)
      ) {
        if (!esHabil(dia)) continue;
        const [abre, cierra] = franja(dia);
        const tramo = Math.min(hasta, cierra) - Math.max(desde, abre);
        if (tramo > 0) total += tramo;
      }
      return total / MS_MIN;
    },

    isOpenAt: abierto,

    nextOpeningAfter(at) {
      if (abierto(at)) return null;
      const t = at.getTime();
      const inicio = fechaDe(t, timeZone);
      for (let i = 0; i <= MAX_SEARCH_DAYS; i++) {
        const dia = sumarDias(inicio, i);
        if (!esHabil(dia)) continue;
        const [abre] = franja(dia);
        if (abre > t) return new Date(abre);
      }
      throw imposible();
    },
  };
};

/** El calendario con el que cuenta el SLA de una organización. */
export function toBusinessCalendar(
  config: BusinessCalendarConfig,
): BusinessCalendar {
  return config.mode === '24_7' ? CALENDAR_24_7 : calendarioHabil(config);
}

const HORA = /^([01]\d|2[0-3]):([0-5]\d)$/;
const aMinutos = (hhmm: string): number | null => {
  const m = HORA.exec(hhmm);
  return m === null ? null : Number(m[1]) * 60 + Number(m[2]);
};

const zonaValida = (timeZone: string): boolean => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
};

/**
 * Valida la semana tipo que manda el ADMIN y la pasa a minutos. Las reglas
 * viven acá y no en el DTO: un calendario sin días hábiles haría que ningún
 * reloj venciera nunca.
 */
export function makeBusinessHours(input: {
  timeZone: string;
  weekdays: number[];
  opensAt: string;
  closesAt: string;
}): Result<BusinessWeek, InvalidBusinessHoursError> {
  const fallo = (detalle: string) =>
    err(new InvalidBusinessHoursError(detalle));

  if (!zonaValida(input.timeZone)) {
    return fallo(`La zona horaria «${input.timeZone}» no existe.`);
  }
  const dias = [...new Set(input.weekdays)].sort((a, b) => a - b);
  if (dias.length === 0) return fallo('Tiene que haber al menos un día hábil.');
  if (dias.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) {
    return fallo('Los días van del 1 (lunes) al 7 (domingo).');
  }
  const abre = aMinutos(input.opensAt);
  const cierra = aMinutos(input.closesAt);
  if (abre === null || cierra === null) {
    return fallo('Las horas van en formato HH:MM, entre 00:00 y 23:59.');
  }
  if (abre >= cierra)
    return fallo('El cierre tiene que ser después de la apertura.');

  return ok({
    timeZone: input.timeZone,
    weekdays: dias as Weekday[],
    opensAtMinute: abre,
    closesAtMinute: cierra,
  });
}

/** 480 → "08:00". Para devolverle al ADMIN lo que cargó. */
export const minutosAHora = (minutos: number): string =>
  `${String(Math.floor(minutos / 60)).padStart(2, '0')}:${String(minutos % 60).padStart(2, '0')}`;
