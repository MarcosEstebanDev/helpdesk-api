/**
 * Puerto de emisión en tiempo real (ADR-0022).
 *
 * La audiencia se expresa en términos de NEGOCIO —"el equipo de esta
 * organización", "quien esté mirando este ticket"— y no como nombres de room de
 * Socket.io. Traducir una cosa en la otra es cosa del adapter: si la aplicación
 * construyera cadenas como `tenant:<id>:staff`, cambiar de transporte (o de
 * convención de nombres) obligaría a tocar reglas de negocio.
 *
 * Toda audiencia lleva `tenantId`, incluida la de un ticket concreto. No es
 * redundante: es lo que hace imposible que un cliente que se invente un
 * `ticketId` ajeno acabe en la room de otra organización, porque el tenant sale
 * siempre del token verificado y nunca de lo que mande el cliente.
 */
export type RealtimeAudience =
  /** Todo el mundo de la organización, incluidos los solicitantes. */
  | { scope: 'tenant'; tenantId: string }
  /** Solo quien atiende: AGENT y ADMIN. */
  | { scope: 'staff'; tenantId: string }
  /** Quien tenga abierto ese ticket. */
  | { scope: 'ticket'; tenantId: string; ticketId: string };

export interface RealtimeMessage {
  /** Nombre del mensaje en el cable, p. ej. `ticket.created`. */
  event: string;
  payload: Record<string, unknown>;
}

export interface RealtimePublisher {
  publish(audience: RealtimeAudience, message: RealtimeMessage): Promise<void>;
}

export const REALTIME_PUBLISHER = Symbol('shared.RealtimePublisher');
