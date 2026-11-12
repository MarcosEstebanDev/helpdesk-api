import { TagId, TenantId, TicketId } from '../ids';

/**
 * Qué etiquetas tiene cada ticket (ADR-0031). No es estado del agregado
 * `Ticket`: cargar el ticket no carga sus etiquetas, y cambiarlas pasa por aquí.
 */
export interface TicketTagRepository {
  tagsOf(tenantId: TenantId, ticketId: TicketId): Promise<TagId[]>;

  /** Reemplaza el conjunto entero. */
  replace(
    tenantId: TenantId,
    ticketId: TicketId,
    tagIds: TagId[],
  ): Promise<void>;
}

export const TICKET_TAG_REPOSITORY = Symbol('ticketing.TicketTagRepository');
