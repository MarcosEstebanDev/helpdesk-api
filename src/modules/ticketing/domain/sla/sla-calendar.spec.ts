import { CALENDAR_24_7 } from './sla-calendar';

describe('SlaCalendar 24/7', () => {
  const inicio = new Date('2026-09-09T10:00:00.000Z');

  it('suma los minutos tal cual', () => {
    expect(CALENDAR_24_7.dueAt(inicio, 90)).toEqual(
      new Date('2026-09-09T11:30:00.000Z'),
    );
  });

  it('no respeta noches ni fines de semana: el reloj corre siempre', () => {
    // Un viernes a las 23:00 + 4 horas cae en sábado de madrugada. Cuando exista
    // el calendario laboral, ESTE es el test que tendrá que dar otro resultado.
    const viernesNoche = new Date('2026-09-11T23:00:00.000Z');

    expect(CALENDAR_24_7.dueAt(viernesNoche, 4 * 60)).toEqual(
      new Date('2026-09-12T03:00:00.000Z'),
    );
  });

  it('no muta la fecha de entrada', () => {
    const copia = new Date(inicio.getTime());

    CALENDAR_24_7.dueAt(inicio, 60);

    expect(inicio).toEqual(copia);
  });
});
