import { Ticket } from '../entities/ticket.entity';
import { TenantId, TicketId } from '../ids';

/**
 * Persistencia del agregado Ticket.
 *
 * `save` es un upsert deliberado: el caso de uso trabaja con el agregado y no
 * quiere saber si por debajo es un INSERT o un UPDATE. Esa distinción es un
 * detalle del adapter.
 */
export interface TicketRepository {
  save(ticket: Ticket): Promise<void>;
  findById(tenantId: TenantId, id: TicketId): Promise<Ticket | null>;

  /**
   * Como `findById`, pero BLOQUEA la fila hasta el fin de la transacción
   * (`SELECT ... FOR UPDATE`). Para los casos de uso que leen el ticket y lo
   * vuelven a guardar entero mientras otro podría cambiarlo: sin el bloqueo,
   * el segundo `save` pisaría el cambio del primero (p. ej. reabriría un
   * ticket recién cerrado). Debe llamarse DENTRO de una transacción.
   */
  findByIdForUpdate(tenantId: TenantId, id: TicketId): Promise<Ticket | null>;
}

export const TICKET_REPOSITORY = Symbol('ticketing.TicketRepository');
