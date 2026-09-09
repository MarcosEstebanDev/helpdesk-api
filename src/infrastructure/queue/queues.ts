/**
 * Nombres de cola y enrutado de eventos (ADR-0019).
 *
 * El mapa vive aquí y no en cada consumidor para que "qué reacciona a qué" se
 * pueda leer de un vistazo. Un evento sin cola asociada NO es un error: se marca
 * como publicado y se acabó, porque nadie lo espera. Si no se hiciera así, esos
 * mensajes se reclamarían una y otra vez para siempre.
 *
 * Un mismo evento puede ir a VARIAS colas: `ticket.created` arranca la
 * auto-asignación y además los relojes de SLA, y son consumidores independientes
 * que no deben esperarse el uno al otro.
 */
export const TICKET_ROUTING_QUEUE = 'ticket-routing';

/** Motor de SLA (ADR-0021): arranca y para relojes según lo que pasa. */
export const SLA_QUEUE = 'sla';

/** Empuje a los clientes conectados por WebSocket (ADR-0023). */
export const REALTIME_QUEUE = 'realtime';

/** Cola de descarte: aquí acaban los jobs que agotaron sus reintentos. */
export const DEAD_LETTER_QUEUE = 'dead-letter';

export const QUEUE_NAMES = [
  TICKET_ROUTING_QUEUE,
  SLA_QUEUE,
  REALTIME_QUEUE,
  DEAD_LETTER_QUEUE,
] as const;

export const EVENT_ROUTING: Readonly<Record<string, readonly string[]>> = {
  'ticket.created': [TICKET_ROUTING_QUEUE, SLA_QUEUE, REALTIME_QUEUE],
  'comment.added': [SLA_QUEUE, REALTIME_QUEUE],
  'ticket.status_changed': [SLA_QUEUE, REALTIME_QUEUE],
  'ticket.assigned': [REALTIME_QUEUE],
  'ticket.unassigned': [REALTIME_QUEUE],
  // Cierra el cabo suelto de la fase 6: `sla.breached` ya tiene consumidor.
  'sla.breached': [REALTIME_QUEUE],
};

export const queuesFor = (eventName: string): readonly string[] =>
  EVENT_ROUTING[eventName] ?? [];
