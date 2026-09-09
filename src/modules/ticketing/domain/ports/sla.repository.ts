import { TicketPriority } from '../ticket-status';
import { SlaKind, SlaTimer } from '../sla/sla-timer.entity';
import { SlaTarget } from '../sla/sla-policy';
import { TenantId, TicketId } from '../ids';

/**
 * Política de SLA configurada por la organización. Devuelve solo lo que el
 * tenant haya sobreescrito; completar con los valores por defecto es cosa del
 * dominio (`resolvePolicy`), no del adapter.
 */
export interface SlaPolicyRepository {
  overridesOf(
    tenantId: TenantId,
  ): Promise<Partial<Record<TicketPriority, SlaTarget>>>;
}

export const SLA_POLICY_REPOSITORY = Symbol('ticketing.SlaPolicyRepository');

export interface SlaTimerRepository {
  save(timer: SlaTimer): Promise<void>;
  findByTicket(tenantId: TenantId, ticketId: TicketId): Promise<SlaTimer[]>;
  findRunning(
    tenantId: TenantId,
    ticketId: TicketId,
    kind: SlaKind,
  ): Promise<SlaTimer | null>;
  findById(tenantId: TenantId, id: string): Promise<SlaTimer | null>;
}

export const SLA_TIMER_REPOSITORY = Symbol('ticketing.SlaTimerRepository');
