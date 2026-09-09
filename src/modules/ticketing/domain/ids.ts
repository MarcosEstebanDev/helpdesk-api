import { Brand, brand } from '../../../shared-kernel';

/**
 * Branded ids del contexto Ticketing (ADR-0006).
 *
 * `TenantId` y `UserId` se declaran aquí en vez de importarse de `iam`: dos
 * bounded contexts no deben depender uno del otro. No se pierde seguridad de
 * tipos porque la marca es la misma cadena ('TenantId'), así que ambos tipos son
 * estructuralmente idénticos y el compilador los acepta indistintamente; lo que
 * se evita es el acoplamiento entre módulos.
 */
export type TenantId = Brand<string, 'TenantId'>;
export const TenantId = (raw: string): TenantId => brand<'TenantId'>(raw);

export type UserId = Brand<string, 'UserId'>;
export const UserId = (raw: string): UserId => brand<'UserId'>(raw);

export type TicketId = Brand<string, 'TicketId'>;
export const TicketId = (raw: string): TicketId => brand<'TicketId'>(raw);

export type CommentId = Brand<string, 'CommentId'>;
export const CommentId = (raw: string): CommentId => brand<'CommentId'>(raw);

export type AuditLogId = Brand<string, 'AuditLogId'>;
export const AuditLogId = (raw: string): AuditLogId => brand<'AuditLogId'>(raw);
