import { CalendarException } from './business-calendar';

/**
 * Feriados NACIONALES de Argentina para precargar en el horario laboral
 * (ADR-0034). Solo los oficiales: inamovibles + trasladables, con los
 * trasladables YA movidos.
 *
 * **Fuente y límite.** Las fechas se calcularon con las reglas de la Ley 27.399
 * (art. 6: un trasladable que cae martes o miércoles pasa al lunes anterior;
 * jueves o viernes, al lunes siguiente; fin de semana, se queda) y la fecha de
 * Pascua de cada año. NO se contrastaron con el decreto de feriados del año
 * (argentina.gob.ar/interior/feriados): si el Poder Ejecutivo fija otra fecha
 * para un trasladable, hay que corregirla acá. El ADMIN puede editar cualquier
 * excepción después de precargarla, así que un error se arregla sin deploy.
 *
 * Quedan FUERA a propósito los "días no laborables con fines turísticos" y el
 * 24 y 31 de diciembre: el sector privado suele trabajarlos (decisión del
 * diseño); quien no los trabaje los agrega a mano.
 */
const POR_ANIO: Record<number, [string, string][]> = {
  2026: [
    ['01-01', 'Año Nuevo'],
    ['02-16', 'Carnaval'],
    ['02-17', 'Carnaval'],
    ['03-24', 'Día Nacional de la Memoria por la Verdad y la Justicia'],
    ['04-02', 'Día del Veterano y de los Caídos en la Guerra de Malvinas'],
    ['04-03', 'Viernes Santo'],
    ['05-01', 'Día del Trabajador'],
    ['05-25', 'Día de la Revolución de Mayo'],
    ['06-15', 'Paso a la Inmortalidad del General Güemes (17/6, trasladado)'],
    ['06-20', 'Paso a la Inmortalidad del General Belgrano'],
    ['07-09', 'Día de la Independencia'],
    ['08-17', 'Paso a la Inmortalidad del General San Martín'],
    ['10-12', 'Día del Respeto a la Diversidad Cultural'],
    ['11-23', 'Día de la Soberanía Nacional (20/11, trasladado)'],
    ['12-08', 'Inmaculada Concepción de María'],
    ['12-25', 'Navidad'],
  ],
  2027: [
    ['01-01', 'Año Nuevo'],
    ['02-08', 'Carnaval'],
    ['02-09', 'Carnaval'],
    ['03-24', 'Día Nacional de la Memoria por la Verdad y la Justicia'],
    ['03-26', 'Viernes Santo'],
    ['04-02', 'Día del Veterano y de los Caídos en la Guerra de Malvinas'],
    ['05-01', 'Día del Trabajador'],
    ['05-25', 'Día de la Revolución de Mayo'],
    ['06-20', 'Paso a la Inmortalidad del General Belgrano'],
    ['06-21', 'Paso a la Inmortalidad del General Güemes (17/6, trasladado)'],
    ['07-09', 'Día de la Independencia'],
    [
      '08-16',
      'Paso a la Inmortalidad del General San Martín (17/8, trasladado)',
    ],
    ['10-11', 'Día del Respeto a la Diversidad Cultural (12/10, trasladado)'],
    ['11-20', 'Día de la Soberanía Nacional'],
    ['12-08', 'Inmaculada Concepción de María'],
    ['12-25', 'Navidad'],
  ],
};

/** Feriados de ese año, o `null` si no hay lista cargada para él. */
export function nationalHolidays(year: number): CalendarException[] | null {
  const lista = POR_ANIO[year];
  if (lista === undefined) return null;
  return lista.map(([mmdd, name]) => ({
    date: `${year}-${mmdd}`,
    working: false,
    name,
  }));
}
