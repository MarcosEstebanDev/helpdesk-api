import { Entity } from '../../../../shared-kernel';
import { AuditLogId, TenantId, UserId } from '../ids';

/**
 * Acciones auditables. Es una lista cerrada y no un `string` libre para que
 * añadir una acción nueva sea una decisión consciente y para que el cliente
 * pueda ramificar por ella sin parsear texto.
 */
export const AUDIT_ACTIONS = [
  'ticket.created',
  'ticket.assigned',
  'ticket.unassigned',
  'ticket.status_changed',
  'ticket.priority_changed',
  'comment.added',
  'sla.breached',
  'sla.policy_changed',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

interface AuditLogProps {
  tenantId: TenantId;
  /** Quién lo hizo. Sale del JWT, jamás del cuerpo de la petición. */
  actorId: UserId;
  action: AuditAction;
  entityType: string;
  entityId: string;
  /** Detalle libre de la acción (p. ej. `{ from: 'OPEN', to: 'RESOLVED' }`). */
  metadata: Record<string, unknown> | null;
  occurredAt: Date;
}

/**
 * Entrada del rastro de auditoría (ADR-0016).
 *
 * Es un hecho ya ocurrido, así que solo tiene constructor y lectores: no existe
 * ninguna operación que la modifique. Se escribe en la MISMA transacción que el
 * cambio que registra, de modo que no puede haber un cambio sin su rastro.
 */
export class AuditLog extends Entity<AuditLogId> {
  private constructor(
    id: AuditLogId,
    private readonly props: AuditLogProps,
  ) {
    super(id);
  }

  get tenantId(): TenantId {
    return this.props.tenantId;
  }

  get actorId(): UserId {
    return this.props.actorId;
  }

  get action(): AuditAction {
    return this.props.action;
  }

  get entityType(): string {
    return this.props.entityType;
  }

  get entityId(): string {
    return this.props.entityId;
  }

  get metadata(): Record<string, unknown> | null {
    return this.props.metadata;
  }

  get occurredAt(): Date {
    return this.props.occurredAt;
  }

  static record(input: {
    id: AuditLogId;
    tenantId: TenantId;
    actorId: UserId;
    action: AuditAction;
    entityType: string;
    entityId: string;
    metadata?: Record<string, unknown> | null;
    now: Date;
  }): AuditLog {
    return new AuditLog(input.id, {
      tenantId: input.tenantId,
      actorId: input.actorId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      metadata: input.metadata ?? null,
      occurredAt: input.now,
    });
  }
}
