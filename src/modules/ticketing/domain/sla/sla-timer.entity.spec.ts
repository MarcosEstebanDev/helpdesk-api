import { SlaTimerId, TenantId, TicketId } from '../ids';
import { CALENDAR_24_7 } from './sla-calendar';
import { SlaTimer, describeSlaTimer } from './sla-timer.entity';

const TENANT = TenantId('11111111-1111-1111-1111-111111111111');
const TICKET = TicketId('44444444-4444-4444-4444-444444444444');
const INICIO = new Date('2026-09-09T10:00:00.000Z');

const arrancar = (minutos = 60): SlaTimer =>
  SlaTimer.start({
    id: SlaTimerId('55555555-5555-5555-5555-555555555555'),
    tenantId: TENANT,
    ticketId: TICKET,
    kind: 'RESPONSE',
    minutes: minutos,
    calendar: CALENDAR_24_7,
    now: INICIO,
  });

describe('SlaTimer', () => {
  describe('al arrancar', () => {
    it('queda corriendo con su vencimiento ya calculado', () => {
      const timer = arrancar(90);

      expect(timer.isRunning()).toBe(true);
      expect(timer.isBreached()).toBe(false);
      expect(timer.startedAt).toEqual(INICIO);
      expect(timer.dueAt).toEqual(new Date('2026-09-09T11:30:00.000Z'));
    });

    it('el vencimiento se persiste, no se recalcula', () => {
      // Es lo que impide que cambiar la política a mitad de partida mueva la
      // portería de los relojes que ya estaban en marcha.
      const timer = arrancar(60);
      const vencimiento = timer.dueAt;

      const recargado = SlaTimer.rehydrate({
        id: timer.id,
        tenantId: timer.tenantId,
        ticketId: timer.ticketId,
        kind: timer.kind,
        startedAt: timer.startedAt,
        dueAt: timer.dueAt,
        stoppedAt: null,
        breachedAt: null,
        pausedAt: null,
      });

      expect(recargado.dueAt).toEqual(vencimiento);
    });
  });

  describe('parar', () => {
    it('deja de correr y guarda cuándo', () => {
      const timer = arrancar();
      const respuesta = new Date('2026-09-09T10:30:00.000Z');

      timer.stop(respuesta, CALENDAR_24_7);

      expect(timer.isRunning()).toBe(false);
      expect(timer.stoppedAt).toEqual(respuesta);
    });

    it('es idempotente: conserva la PRIMERA parada', () => {
      // Lo que interesa es cuándo se cumplió, no la última vez que alguien lo
      // intentó. Con entrega at-least-once esto pasa de verdad.
      const timer = arrancar();
      const primera = new Date('2026-09-09T10:30:00.000Z');

      timer.stop(primera, CALENDAR_24_7);
      timer.stop(new Date('2026-09-09T10:45:00.000Z'), CALENDAR_24_7);

      expect(timer.stoppedAt).toEqual(primera);
    });

    it('calcula el margen que quedaba (negativo si se pasó)', () => {
      const timer = arrancar(60);

      expect(
        timer.remainingMinutesAt(new Date('2026-09-09T10:45:00.000Z')),
      ).toBe(15);
      expect(
        timer.remainingMinutesAt(new Date('2026-09-09T11:20:00.000Z')),
      ).toBe(-20);
    });
  });

  describe('vencimiento', () => {
    it('no está vencido antes de su hora', () => {
      const timer = arrancar(60);

      expect(timer.isOverdue(new Date('2026-09-09T10:59:59.000Z'))).toBe(false);
      expect(timer.isOverdue(new Date('2026-09-09T11:00:00.000Z'))).toBe(true);
    });

    it('un reloj ya parado NUNCA está vencido', () => {
      // El barrido puede llegar tarde: si alguien respondió mientras tanto, el
      // SLA se cumplió y no puede incumplir a posteriori.
      const timer = arrancar(60);
      timer.stop(new Date('2026-09-09T10:30:00.000Z'), CALENDAR_24_7);

      expect(timer.isOverdue(new Date('2026-09-09T23:00:00.000Z'))).toBe(false);
    });
  });

  describe('incumplimiento', () => {
    it('marca el reloj y devuelve true', () => {
      const timer = arrancar(60);
      const barrido = new Date('2026-09-09T11:05:00.000Z');

      expect(timer.markBreached(barrido)).toBe(true);
      expect(timer.isBreached()).toBe(true);
      expect(timer.isRunning()).toBe(false);
      expect(timer.breachedAt).toEqual(barrido);
    });

    it('no puede incumplir un reloj ya parado a tiempo', () => {
      const timer = arrancar(60);
      timer.stop(new Date('2026-09-09T10:30:00.000Z'), CALENDAR_24_7);

      expect(timer.markBreached(new Date('2026-09-09T11:05:00.000Z'))).toBe(
        false,
      );
      expect(timer.isBreached()).toBe(false);
    });

    it('marcar dos veces no cambia la primera fecha', () => {
      // Dos barridos concurrentes pueden coger el mismo reloj: el segundo se
      // encuentra con que ya no corre y se retira. Idempotencia por condición.
      const timer = arrancar(60);
      const primera = new Date('2026-09-09T11:05:00.000Z');

      timer.markBreached(primera);
      expect(timer.markBreached(new Date('2026-09-09T12:00:00.000Z'))).toBe(
        false,
      );
      expect(timer.breachedAt).toEqual(primera);
    });

    it('un reloj incumplido ya no se puede parar', () => {
      const timer = arrancar(60);
      timer.markBreached(new Date('2026-09-09T11:05:00.000Z'));

      timer.stop(new Date('2026-09-09T11:30:00.000Z'), CALENDAR_24_7);

      expect(timer.stoppedAt).toBeNull();
      expect(timer.isBreached()).toBe(true);
    });
  });

  describe('pausa (ADR-0029)', () => {
    // Reloj de 240 min arrancado a las 10:00: vence a las 14:00.
    const h = (hora: string) => new Date(`2026-09-09T${hora}:00.000Z`);

    it('pausar lo saca de "corriendo" sin cerrarlo', () => {
      const timer = arrancar(240);

      expect(timer.pause(h('11:00'))).toBe(true);

      expect(timer.isPaused()).toBe(true);
      expect(timer.isRunning()).toBe(false);
      expect(timer.isOpen()).toBe(true);
      expect(timer.pausedAt).toEqual(h('11:00'));
    });

    it('pausar dos veces conserva la primera pausa', () => {
      const timer = arrancar(240);
      timer.pause(h('11:00'));

      expect(timer.pause(h('11:30'))).toBe(false);
      expect(timer.pausedAt).toEqual(h('11:00'));
    });

    it('reanudar corre el vencimiento lo que duró la pausa', () => {
      const timer = arrancar(240);
      timer.pause(h('11:00'));

      expect(timer.resume(h('12:30'), CALENDAR_24_7)).toBe(true);

      expect(timer.dueAt).toEqual(h('15:30'));
      expect(timer.pausedAt).toBeNull();
      expect(timer.isRunning()).toBe(true);
    });

    it('reanudar un reloj que no está pausado no hace nada', () => {
      const timer = arrancar(240);

      expect(timer.resume(h('12:30'), CALENDAR_24_7)).toBe(false);
      expect(timer.dueAt).toEqual(h('14:00'));
    });

    it('un reloj pausado no puede incumplir', () => {
      const timer = arrancar(240);
      timer.pause(h('11:00'));

      expect(timer.markBreached(h('15:00'))).toBe(false);
      expect(timer.breachedAt).toBeNull();
      expect(timer.isOverdue(h('15:00'))).toBe(false);
    });

    it('parar un reloj pausado descuenta la pausa del margen', () => {
      // Resolver directamente desde la espera: no puede quedar pausado para
      // siempre, y las dos horas de espera no cuentan.
      const timer = arrancar(240);
      timer.pause(h('11:00'));

      timer.stop(h('13:00'), CALENDAR_24_7);

      expect(timer.stoppedAt).toEqual(h('13:00'));
      expect(timer.pausedAt).toBeNull();
      expect(timer.isOpen()).toBe(false);
      expect(timer.dueAt).toEqual(h('16:00'));
      expect(timer.remainingMinutesAt(h('13:00'))).toBe(180);
    });

    it('no se puede pausar un reloj ya vencido que el barrido aún no marcó', () => {
      // El barrido pasa cada 30 s: en ese hueco el reloj ya incumplió aunque la
      // fila no lo diga. Pausarlo le borraría el retraso (al reanudar, el margen
      // restante sería 0 y `dueAt` saltaría a "ahora"). Tiene que incumplir con
      // su vencimiento real.
      const timer = arrancar(240);

      expect(timer.pause(h('14:01'))).toBe(false);
      expect(timer.pausedAt).toBeNull();
      expect(timer.isOverdue(h('14:01'))).toBe(true);
    });

    it('no se puede pausar un reloj incumplido ni uno parado', () => {
      const incumplido = arrancar(240);
      incumplido.markBreached(h('14:05'));
      const parado = arrancar(240);
      parado.stop(h('12:00'), CALENDAR_24_7);

      expect(incumplido.pause(h('14:10'))).toBe(false);
      expect(parado.pause(h('12:10'))).toBe(false);
      expect(incumplido.pausedAt).toBeNull();
      expect(parado.pausedAt).toBeNull();
    });
  });
});

describe('describeSlaTimer', () => {
  const VENCE = new Date('2026-09-09T12:00:00.000Z');
  const base = { kind: 'RESPONSE' as const, dueAt: VENCE };

  it('un reloj en marcha se mide contra AHORA', () => {
    const vista = describeSlaTimer(
      { ...base, stoppedAt: null, breachedAt: null, pausedAt: null },
      new Date('2026-09-09T11:30:00.000Z'),
    );

    expect(vista.status).toBe('running');
    expect(vista.remainingMinutes).toBe(30);
  });

  it('un reloj cumplido se mide contra su hora de parada, no contra ahora', () => {
    // Si se midiera contra ahora, el margen de un ticket ya resuelto empeoraría
    // cada vez que alguien abre la pantalla.
    const vista = describeSlaTimer(
      {
        ...base,
        stoppedAt: new Date('2026-09-09T11:45:00.000Z'),
        breachedAt: null,
        pausedAt: null,
      },
      new Date('2026-09-10T00:00:00.000Z'),
    );

    expect(vista.status).toBe('met');
    expect(vista.remainingMinutes).toBe(15);
  });

  it('un reloj incumplido dice cuánto se pasó', () => {
    const vista = describeSlaTimer(
      {
        ...base,
        stoppedAt: null,
        breachedAt: new Date('2026-09-09T12:20:00.000Z'),
        pausedAt: null,
      },
      new Date('2026-09-10T00:00:00.000Z'),
    );

    expect(vista.status).toBe('breached');
    expect(vista.remainingMinutes).toBe(-20);
  });

  it('el margen de un reloj en marcha ya vencido es negativo', () => {
    // El barrido puede no haber pasado todavía: la vista no miente diciendo que
    // va bien, pero tampoco lo marca como incumplido antes de que se registre.
    const vista = describeSlaTimer(
      { ...base, stoppedAt: null, breachedAt: null, pausedAt: null },
      new Date('2026-09-09T12:10:00.000Z'),
    );

    expect(vista.status).toBe('running');
    expect(vista.remainingMinutes).toBe(-10);
  });

  it('un reloj en pausa congela su margen en la hora de la pausa', () => {
    // Si se midiera contra ahora, la pantalla enseñaría un margen bajando
    // mientras la pelota está del lado del cliente (ADR-0029).
    const pausa = new Date('2026-09-09T11:00:00.000Z');
    const vista = describeSlaTimer(
      { ...base, stoppedAt: null, breachedAt: null, pausedAt: pausa },
      new Date('2026-09-09T20:00:00.000Z'),
    );

    expect(vista.status).toBe('paused');
    expect(vista.remainingMinutes).toBe(60);
    expect(vista.pausedAt).toEqual(pausa);
  });
});
