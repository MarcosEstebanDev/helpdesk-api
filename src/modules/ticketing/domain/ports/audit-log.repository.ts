import { AuditLog } from '../entities/audit-log.entity';

/**
 * Escritura del rastro de auditoría. Solo `record`: la auditoría no se lee desde
 * el lado de escritura (para eso está el read model) y desde luego no se edita.
 */
export interface AuditLogRepository {
  record(entry: AuditLog): Promise<void>;
}

export const AUDIT_LOG_REPOSITORY = Symbol('ticketing.AuditLogRepository');
