/**
 * Ciclo de vida de un ticket (ADR-0015).
 *
 *   OPEN        -> IN_PROGRESS | RESOLVED
 *   IN_PROGRESS -> RESOLVED    | OPEN      (vuelve a la cola al desasignarse)
 *   RESOLVED    -> CLOSED      | OPEN      (el cliente dice que no estaba arreglado)
 *   CLOSED      -> (terminal)
 *
 * Las transiciones se declaran como DATOS y no como cadenas de `if`. Así el
 * conjunto de transiciones legales se puede leer de un vistazo, testear
 * exhaustivamente recorriendo la tabla, y —cuando llegue la fase 6— consultar
 * desde el motor de SLA sin duplicar la regla.
 */
export const TICKET_STATUSES = [
  'OPEN',
  'IN_PROGRESS',
  'RESOLVED',
  'CLOSED',
] as const;

export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const isTicketStatus = (value: string): value is TicketStatus =>
  (TICKET_STATUSES as readonly string[]).includes(value);

export const TICKET_PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const;

export type TicketPriority = (typeof TICKET_PRIORITIES)[number];

export const isTicketPriority = (value: string): value is TicketPriority =>
  (TICKET_PRIORITIES as readonly string[]).includes(value);

/**
 * Transiciones permitidas desde cada estado.
 *
 * `CLOSED` es TERMINAL a propósito: un ticket cerrado es el registro histórico
 * de una incidencia ya zanjada, y reabrirlo mezclaría en una misma fila dos
 * incidencias distintas —con sus tiempos de SLA solapados—. Si el problema
 * vuelve, se abre un ticket nuevo que puede enlazar al anterior. Reabrir sí se
 * permite desde `RESOLVED`, que es justo la ventana en la que el cliente puede
 * decir "esto no estaba arreglado".
 */
const ALLOWED_TRANSITIONS: Record<TicketStatus, readonly TicketStatus[]> = {
  OPEN: ['IN_PROGRESS', 'RESOLVED'],
  IN_PROGRESS: ['RESOLVED', 'OPEN'],
  RESOLVED: ['CLOSED', 'OPEN'],
  CLOSED: [],
};

export const canTransition = (from: TicketStatus, to: TicketStatus): boolean =>
  ALLOWED_TRANSITIONS[from].includes(to);

/** Estados a los que se puede pasar desde `from` (para tests y para la API). */
export const allowedTransitionsFrom = (
  from: TicketStatus,
): readonly TicketStatus[] => ALLOWED_TRANSITIONS[from];

/** Un ticket cerrado ya no admite cambios de ningún tipo. */
export const isTerminal = (status: TicketStatus): boolean =>
  ALLOWED_TRANSITIONS[status].length === 0;
