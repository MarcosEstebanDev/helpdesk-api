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
  /**
   * Da de alta un reloj recién arrancado. Solo crea: los cambios de un reloj ya
   * existente van por `transition`, que es condicionado.
   */
  save(timer: SlaTimer): Promise<void>;
  findByTicket(tenantId: TenantId, ticketId: TicketId): Promise<SlaTimer[]>;
  /**
   * El reloj ABIERTO de ese tipo: corriendo o en pausa (ADR-0029). Ni los
   * cumplidos ni los incumplidos.
   */
  findOpen(
    tenantId: TenantId,
    ticketId: TicketId,
    kind: SlaKind,
  ): Promise<SlaTimer | null>;
  findById(tenantId: TenantId, id: string): Promise<SlaTimer | null>;
  /**
   * Persiste una transición del reloj (pausar, reanudar, parar, incumplir) SOLO
   * si la fila sigue en el estado `expected` en el que se leyó: un
   * `UPDATE ... WHERE` condicionado, no un upsert. Devuelve si escribió.
   *
   * `false` significa que otra escritura ganó la carrera (el barrido incumplió
   * el reloj mientras el agente lo pausaba, o al revés) y que el llamador NO
   * debe actuar como si su cambio hubiera ocurrido. Es la "idempotencia por
   * condición, no por bloqueo" del ADR-0021, ahora cumplida también al escribir.
   */
  transition(timer: SlaTimer, expected: 'running' | 'paused'): Promise<boolean>;
}

export const SLA_TIMER_REPOSITORY = Symbol('ticketing.SlaTimerRepository');
