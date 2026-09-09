import { SlaTimerId, TenantId, TicketId } from '../ids';
import { CALENDAR_24_7 } from './sla-calendar';
import { SlaTimer } from './sla-timer.entity';

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
      });

      expect(recargado.dueAt).toEqual(vencimiento);
    });
  });

  describe('parar', () => {
    it('deja de correr y guarda cuándo', () => {
      const timer = arrancar();
      const respuesta = new Date('2026-09-09T10:30:00.000Z');

      timer.stop(respuesta);

      expect(timer.isRunning()).toBe(false);
      expect(timer.stoppedAt).toEqual(respuesta);
    });

    it('es idempotente: conserva la PRIMERA parada', () => {
      // Lo que interesa es cuándo se cumplió, no la última vez que alguien lo
      // intentó. Con entrega at-least-once esto pasa de verdad.
      const timer = arrancar();
      const primera = new Date('2026-09-09T10:30:00.000Z');

      timer.stop(primera);
      timer.stop(new Date('2026-09-09T10:45:00.000Z'));

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
      timer.stop(new Date('2026-09-09T10:30:00.000Z'));

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
      timer.stop(new Date('2026-09-09T10:30:00.000Z'));

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

      timer.stop(new Date('2026-09-09T11:30:00.000Z'));

      expect(timer.stoppedAt).toBeNull();
      expect(timer.isBreached()).toBe(true);
    });
  });
});
