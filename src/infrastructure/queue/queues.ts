/**
 * Nombres de cola y enrutado de eventos (ADR-0019).
 *
 * El mapa vive aquí y no en cada consumidor para que "qué reacciona a qué" se
 * pueda leer de un vistazo. Un evento sin cola asociada NO es un error: se marca
 * como publicado y se acabó, porque nadie lo espera. Si no se hiciera así, esos
 * mensajes se reclamarían una y otra vez para siempre.
 */
export const TICKET_ROUTING_QUEUE = 'ticket-routing';

/** Cola de descarte: aquí acaban los jobs que agotaron sus reintentos. */
export const DEAD_LETTER_QUEUE = 'dead-letter';

export const QUEUE_NAMES = [TICKET_ROUTING_QUEUE, DEAD_LETTER_QUEUE] as const;

export const EVENT_ROUTING: Readonly<Record<string, readonly string[]>> = {
  'ticket.created': [TICKET_ROUTING_QUEUE],
};

export const queuesFor = (eventName: string): readonly string[] =>
  EVENT_ROUTING[eventName] ?? [];
