import { IdGenerator } from '../../../shared-kernel';
import { AuditAction, AuditLog } from '../domain/entities/audit-log.entity';
import { AuditLogId, TenantId, UserId } from '../domain/ids';
import { AuditLogRepository } from '../domain/ports/audit-log.repository';

/**
 * Servicio de aplicación que escribe el rastro de auditoría (ADR-0016).
 *
 * Se factoriza aquí y no se repite en cada caso de uso para que todos generen la
 * entrada de la misma forma. Nótese que NO abre transacción propia: se apoya en
 * la que ya abrió el caso de uso, que es justo lo que garantiza la atomicidad
 * entre el cambio y su registro.
 */
export class AuditRecorder {
  constructor(
    private readonly ids: IdGenerator,
    private readonly auditLogs: AuditLogRepository,
  ) {}

  async record(input: {
    tenantId: TenantId;
    actorId: UserId;
    action: AuditAction;
    entityType: string;
    entityId: string;
    metadata?: Record<string, unknown> | null;
    now: Date;
  }): Promise<void> {
    await this.auditLogs.record(
      AuditLog.record({
        id: AuditLogId(this.ids.uuid()),
        tenantId: input.tenantId,
        actorId: input.actorId,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId,
        metadata: input.metadata,
        now: input.now,
      }),
    );
  }
}
