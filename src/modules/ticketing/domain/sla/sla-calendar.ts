/**
 * Calendario sobre el que se cuentan los minutos de un SLA (ADR-0020).
 *
 * Hoy solo existe el calendario 24/7 y `dueAt` es una suma. La función existe
 * igualmente —en vez de un `new Date(inicio + minutos)` esparcido por ahí—
 * porque es LA COSTURA por la que entrará el horario laboral: cuando haya que
 * contar solo de lunes a viernes de 9 a 18 en la zona horaria del tenant, se
 * implementa otro `SlaCalendar` y ni el motor ni los consumidores se enteran.
 *
 * Aislar hoy lo que sabemos que va a cambiar mañana cuesta una interfaz; no
 * aislarlo cuesta reescribir todos los sitios donde se sumó tiempo a mano.
 */
export interface SlaCalendar {
  readonly name: string;
  /** Instante en que vencen `minutes` minutos de trabajo contados desde `from`. */
  dueAt(from: Date, minutes: number): Date;
  /**
   * Minutos de TRABAJO entre dos instantes (0 si `to` no es posterior), sin
   * redondear. Es la inversa de `dueAt` y la usa la reanudación de una pausa
   * (ADR-0029): "cuánto margen quedaba" se mide en el calendario, no restando
   * fechas, para que el horario laboral no obligue a reescribir la pausa.
   */
  workingMinutesBetween(from: Date, to: Date): number;
}

const MS_PER_MINUTE = 60_000;

/** El reloj corre siempre: noches, fines de semana y festivos incluidos. */
export const CALENDAR_24_7: SlaCalendar = {
  name: '24/7',
  dueAt: (from, minutes) => new Date(from.getTime() + minutes * MS_PER_MINUTE),
  workingMinutesBetween: (from, to) =>
    Math.max(0, (to.getTime() - from.getTime()) / MS_PER_MINUTE),
};
