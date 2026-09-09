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

  /**
   * Fija el objetivo de UNA prioridad. Es un upsert porque al administrador le
   * da igual si ya había una fila: lo que pide es "a partir de ahora, urgente
   * son 5 minutos".
   */
  upsert(input: {
    tenantId: TenantId;
    priority: TicketPriority;
    target: SlaTarget;
    now: Date;
  }): Promise<void>;

  /**
   * Quita el override de una prioridad, devolviéndola al valor por defecto del
   * dominio. Devuelve si había algo que quitar, para que el caso de uso no
   * escriba una entrada de auditoría por un cambio que no ocurrió.
   */
  remove(tenantId: TenantId, priority: TicketPriority): Promise<boolean>;
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
