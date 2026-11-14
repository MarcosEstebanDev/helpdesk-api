import { TenantId, TicketId } from '../ids';
import { TicketTriage } from '../triage/ticket-triage.entity';

export interface TicketTriageRepository {
  /**
   * Guarda la sugerencia. Si el ticket ya tenía una, NO la pisa: la primera
   * gana, y reprocesar un evento no reescribe con qué modelo se clasificó.
   */
  save(triage: TicketTriage): Promise<void>;
  findByTicket(
    tenantId: TenantId,
    ticketId: TicketId,
  ): Promise<TicketTriage | null>;
}

export const TICKET_TRIAGE_REPOSITORY = Symbol(
  'ticketing.TicketTriageRepository',
);
