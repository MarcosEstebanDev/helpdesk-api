import { TenantId } from '../ids';

/**
 * Reserva el siguiente número visible de ticket para un tenant (ADR-0017).
 *
 * Es un puerto propio y no un método del repositorio porque la garantía que
 * ofrece es distinta: el repositorio guarda lo que le dan, mientras que esto
 * consume un recurso compartido y debe hacerlo bajo el bloqueo de la fila del
 * contador. Debe invocarse DENTRO de la transacción que crea el ticket; si esa
 * transacción aborta, el número se libera con ella.
 */
export interface TicketNumberGenerator {
  next(tenantId: TenantId): Promise<number>;
}

export const TICKET_NUMBER_GENERATOR = Symbol(
  'ticketing.TicketNumberGenerator',
);
