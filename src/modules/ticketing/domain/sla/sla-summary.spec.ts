import { summarizeSla } from './sla-summary';

const AHORA = new Date('2026-11-13T12:00:00.000Z');
const h = (hh: string) => new Date(`2026-11-13T${hh}:00.000Z`);
const reloj = (p: {
  dueAt: Date;
  stoppedAt?: Date | null;
  breachedAt?: Date | null;
  pausedAt?: Date | null;
}) => ({ stoppedAt: null, breachedAt: null, pausedAt: null, ...p });

describe('summarizeSla', () => {
  it('sin relojes no hay nada que mostrar', () => {
    expect(summarizeSla('OPEN', [], AHORA)).toEqual({ state: 'none' });
  });

  it('elige el vencimiento más próximo de los que corren', () => {
    expect(
      summarizeSla(
        'OPEN',
        [reloj({ dueAt: h('18:00') }), reloj({ dueAt: h('13:00') })],
        AHORA,
      ),
    ).toEqual({ state: 'running', dueAt: h('13:00') });
  });

  // Regla B (decidida 2026-11-13): la bandeja muestra lo que todavía se puede
  // salvar. Un reloj incumplido nunca se para (el dominio no registra si
  // después se respondió), así que si ganara siempre, la fila quedaría en rojo
  // hasta resolver el ticket aunque ya se hubiera respondido.
  it('un reloj que corre gana al incumplido: muestra lo que se puede salvar', () => {
    expect(
      summarizeSla(
        'IN_PROGRESS',
        [
          reloj({ dueAt: h('13:00') }),
          reloj({ dueAt: h('09:00'), breachedAt: h('09:05') }),
        ],
        AHORA,
      ),
    ).toEqual({ state: 'running', dueAt: h('13:00') });
  });

  it('respuesta incumplida y resolución en pausa: en pausa, no "vencido"', () => {
    expect(
      summarizeSla(
        'WAITING_ON_CUSTOMER',
        [
          reloj({ dueAt: h('09:00'), breachedAt: h('09:05') }),
          reloj({ dueAt: h('18:00'), pausedAt: h('10:00') }),
        ],
        AHORA,
      ),
    ).toEqual({ state: 'paused' });
  });

  it('sin ningún reloj vivo, se muestra el incumplimiento más viejo', () => {
    expect(
      summarizeSla(
        'IN_PROGRESS',
        [
          reloj({ dueAt: h('10:00'), breachedAt: h('10:05') }),
          reloj({ dueAt: h('09:00'), breachedAt: h('09:05') }),
        ],
        AHORA,
      ),
    ).toEqual({ state: 'breached', since: h('09:05') });
  });

  it('vencido sin marcar cuenta igual que incumplido: el barrido no cambia la fila', () => {
    // Si no, la fila pasaría de rojo a "vence en…" justo cuando el barrido lo
    // marca, sin que nadie haya hecho nada.
    expect(
      summarizeSla(
        'IN_PROGRESS',
        [reloj({ dueAt: h('11:00') }), reloj({ dueAt: h('18:00') })],
        AHORA,
      ),
    ).toEqual({ state: 'running', dueAt: h('18:00') });
  });

  it('un reloj vencido que el barrido aún no marcó también es incumplido', () => {
    expect(summarizeSla('OPEN', [reloj({ dueAt: h('11:00') })], AHORA)).toEqual(
      {
        state: 'breached',
        since: h('11:00'),
      },
    );
  });

  it('solo relojes en pausa: en pausa', () => {
    expect(
      summarizeSla(
        'WAITING_ON_CUSTOMER',
        [reloj({ dueAt: h('18:00'), pausedAt: h('10:00') })],
        AHORA,
      ),
    ).toEqual({ state: 'paused' });
  });

  it('los cumplidos no cuentan', () => {
    expect(
      summarizeSla(
        'OPEN',
        [reloj({ dueAt: h('09:00'), stoppedAt: h('08:00') })],
        AHORA,
      ),
    ).toEqual({ state: 'none' });
  });

  it.each(['RESOLVED', 'CLOSED'] as const)(
    'un ticket %s no muestra SLA aunque un reloj haya incumplido',
    (status) => {
      expect(
        summarizeSla(
          status,
          [reloj({ dueAt: h('09:00'), breachedAt: h('09:05') })],
          AHORA,
        ),
      ).toEqual({ state: 'none' });
    },
  );
});
