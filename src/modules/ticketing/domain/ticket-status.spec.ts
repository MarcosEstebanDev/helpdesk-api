import {
  TICKET_STATUSES,
  TicketStatus,
  allowedTransitionsFrom,
  canTransition,
  isTerminal,
  isTicketPriority,
  isTicketStatus,
} from './ticket-status';

/**
 * La máquina de estados (ADR-0015) es la regla de negocio central de la fase 4,
 * así que se testea de forma EXHAUSTIVA: no con unos cuantos casos elegidos a
 * mano, sino recorriendo el producto cartesiano de estados. Así, añadir un
 * estado nuevo sin decidir sus transiciones hace fallar la suite en vez de
 * colarse en silencio.
 */
describe('máquina de estados del ticket', () => {
  const TRANSICIONES_PERMITIDAS: ReadonlyArray<[TicketStatus, TicketStatus]> = [
    ['OPEN', 'IN_PROGRESS'],
    ['OPEN', 'RESOLVED'],
    ['IN_PROGRESS', 'RESOLVED'],
    ['IN_PROGRESS', 'OPEN'],
    ['RESOLVED', 'CLOSED'],
    ['RESOLVED', 'OPEN'],
  ];

  const estaPermitida = (from: TicketStatus, to: TicketStatus): boolean =>
    TRANSICIONES_PERMITIDAS.some(([f, t]) => f === from && t === to);

  it.each(TICKET_STATUSES)(
    'desde %s solo acepta las transiciones declaradas',
    (from) => {
      for (const to of TICKET_STATUSES) {
        expect(canTransition(from, to)).toBe(estaPermitida(from, to));
      }
    },
  );

  it('ningún estado se puede transicionar a sí mismo', () => {
    // La idempotencia la resuelve la entidad ANTES de consultar la tabla; la
    // tabla en sí no considera legal quedarse donde ya se está.
    for (const status of TICKET_STATUSES) {
      expect(canTransition(status, status)).toBe(false);
    }
  });

  it('CLOSED es el único estado terminal', () => {
    expect(isTerminal('CLOSED')).toBe(true);
    expect(allowedTransitionsFrom('CLOSED')).toHaveLength(0);

    for (const status of TICKET_STATUSES.filter((s) => s !== 'CLOSED')) {
      expect(isTerminal(status)).toBe(false);
    }
  });

  it('no se puede cerrar un ticket sin haberlo resuelto antes', () => {
    // Regla de producto: CLOSED solo se alcanza desde RESOLVED. Evita cerrar
    // incidencias sin dejar constancia de que se arreglaron.
    expect(canTransition('OPEN', 'CLOSED')).toBe(false);
    expect(canTransition('IN_PROGRESS', 'CLOSED')).toBe(false);
    expect(canTransition('RESOLVED', 'CLOSED')).toBe(true);
  });

  it('un ticket resuelto se puede reabrir, uno cerrado no', () => {
    expect(canTransition('RESOLVED', 'OPEN')).toBe(true);
    expect(canTransition('CLOSED', 'OPEN')).toBe(false);
  });

  describe('type guards', () => {
    it('reconocen los valores válidos y rechazan el resto', () => {
      expect(isTicketStatus('OPEN')).toBe(true);
      expect(isTicketStatus('ARCHIVED')).toBe(false);
      expect(isTicketPriority('URGENT')).toBe(true);
      expect(isTicketPriority('CRITICAL')).toBe(false);
    });
  });
});
