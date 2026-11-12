import { TicketId } from '../../domain/ids';
import { CALENDAR_24_7 } from '../../domain/sla/sla-calendar';
import { SlaKind, SlaTimer } from '../../domain/sla/sla-timer.entity';
import { SlaTimerId } from '../../domain/ids';
import { TicketStatus } from '../../domain/ticket-status';
import { TENANT, fakeSlaTimers } from '../ticketing.test-doubles';
import { SlaPauseCoordinator } from './sla-pause-coordinator';

const TICKET_ID = TicketId('44444444-4444-4444-4444-444444444444');
const RESOLUCION = SlaTimerId('55555555-5555-5555-5555-555555555555');
const h = (hora: string) => new Date(`2026-09-09T${hora}:00.000Z`);

/** Reloj de 240 min arrancado a las 10:00: vence a las 14:00. */
const sembrar = (
  timers: ReturnType<typeof fakeSlaTimers>,
  kind: SlaKind = 'RESOLUTION',
): SlaTimer => {
  const timer = SlaTimer.start({
    id: RESOLUCION,
    tenantId: TENANT,
    ticketId: TICKET_ID,
    kind,
    minutes: 240,
    calendar: CALENDAR_24_7,
    now: h('10:00'),
  });
  timers.seed(timer);
  return timer;
};

describe('SlaPauseCoordinator (ADR-0029)', () => {
  const build = () => {
    const timers = fakeSlaTimers();
    return { timers, sut: new SlaPauseCoordinator(timers) };
  };

  const cambio = (
    sut: SlaPauseCoordinator,
    from: TicketStatus,
    to: TicketStatus,
    now: Date,
  ) =>
    sut.onStatusChange({
      tenantId: TENANT,
      ticketId: TICKET_ID,
      from,
      to,
      now,
    });

  it('pasar a la espera pausa el reloj de resolución', async () => {
    const { sut, timers } = build();
    sembrar(timers);

    const r = await cambio(
      sut,
      'IN_PROGRESS',
      'WAITING_ON_CUSTOMER',
      h('11:00'),
    );

    expect(r).toBe('paused');
    expect(timers.stored(RESOLUCION)?.pausedAt).toEqual(h('11:00'));
  });

  it('volver a IN_PROGRESS lo reanuda corriendo el vencimiento', async () => {
    const { sut, timers } = build();
    sembrar(timers);
    await cambio(sut, 'IN_PROGRESS', 'WAITING_ON_CUSTOMER', h('11:00'));

    const r = await cambio(
      sut,
      'WAITING_ON_CUSTOMER',
      'IN_PROGRESS',
      h('12:30'),
    );

    expect(r).toBe('resumed');
    const guardado = timers.stored(RESOLUCION);
    expect(guardado?.pausedAt).toBeNull();
    expect(guardado?.dueAt).toEqual(h('15:30'));
  });

  it('resolver desde la espera no toca el reloj: lo para el consumidor', async () => {
    const { sut, timers } = build();
    sembrar(timers);
    await cambio(sut, 'IN_PROGRESS', 'WAITING_ON_CUSTOMER', h('11:00'));

    const r = await cambio(sut, 'WAITING_ON_CUSTOMER', 'RESOLVED', h('12:00'));

    expect(r).toBe('none');
    expect(timers.stored(RESOLUCION)?.isPaused()).toBe(true);
  });

  it('sin reloj de resolución no hace nada, y no es un error', async () => {
    const { sut } = build();

    const r = await cambio(
      sut,
      'IN_PROGRESS',
      'WAITING_ON_CUSTOMER',
      h('11:00'),
    );

    expect(r).toBe('none');
  });

  it('solo pausa el de RESOLUCIÓN, nunca el de respuesta', async () => {
    const { sut, timers } = build();
    sembrar(timers, 'RESPONSE');

    const r = await cambio(
      sut,
      'IN_PROGRESS',
      'WAITING_ON_CUSTOMER',
      h('11:00'),
    );

    expect(r).toBe('none');
    expect(timers.stored(RESOLUCION)?.isRunning()).toBe(true);
  });

  it('un reloj ya incumplido sigue incumplido al pasar a la espera', async () => {
    const { sut, timers } = build();
    const timer = sembrar(timers);
    timer.markBreached(h('14:05'));
    timers.seed(timer);

    const r = await cambio(
      sut,
      'IN_PROGRESS',
      'WAITING_ON_CUSTOMER',
      h('15:00'),
    );

    expect(r).toBe('none');
    const guardado = timers.stored(RESOLUCION);
    expect(guardado?.isBreached()).toBe(true);
    expect(guardado?.pausedAt).toBeNull();
  });

  it('si la escritura pierde la carrera, informa que no hizo nada', async () => {
    const { sut, timers } = build();
    sembrar(timers);
    timers.loseNextTransition();

    const r = await cambio(
      sut,
      'IN_PROGRESS',
      'WAITING_ON_CUSTOMER',
      h('11:00'),
    );

    expect(r).toBe('none');
    expect(timers.stored(RESOLUCION)?.pausedAt).toBeNull();
  });

  it('espera → retomar → espera: el tramo trabajado SÍ cuenta', async () => {
    // El contraejemplo que tumbó la opción diferida: 5 min de pausa, 1 min de
    // trabajo, 60 min de pausa. El vencimiento se corre 65 min, no 66.
    const { sut, timers } = build();
    sembrar(timers);

    await cambio(sut, 'IN_PROGRESS', 'WAITING_ON_CUSTOMER', h('10:00'));
    await cambio(sut, 'WAITING_ON_CUSTOMER', 'IN_PROGRESS', h('10:05'));
    await cambio(sut, 'IN_PROGRESS', 'WAITING_ON_CUSTOMER', h('10:06'));
    await cambio(sut, 'WAITING_ON_CUSTOMER', 'IN_PROGRESS', h('11:06'));

    expect(timers.stored(RESOLUCION)?.dueAt).toEqual(h('15:05'));
  });
});
