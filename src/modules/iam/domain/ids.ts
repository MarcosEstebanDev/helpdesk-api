import { Brand, brand } from '../../../shared-kernel';

/**
 * Branded ids del contexto IAM (ADR-0006). El compilador rechaza pasar un
 * `UserId` donde se espera un `TenantId`, etc. — aislamiento por diseño.
 */
export type TenantId = Brand<string, 'TenantId'>;
export const TenantId = (raw: string): TenantId => brand<'TenantId'>(raw);

export type UserId = Brand<string, 'UserId'>;
export const UserId = (raw: string): UserId => brand<'UserId'>(raw);

export type MembershipId = Brand<string, 'MembershipId'>;
export const MembershipId = (raw: string): MembershipId =>
  brand<'MembershipId'>(raw);

export type RefreshTokenId = Brand<string, 'RefreshTokenId'>;
export const RefreshTokenId = (raw: string): RefreshTokenId =>
  brand<'RefreshTokenId'>(raw);

/** Identifica una "familia" de refresh tokens encadenados por rotación. */
export type RefreshFamilyId = Brand<string, 'RefreshFamilyId'>;
export const RefreshFamilyId = (raw: string): RefreshFamilyId =>
  brand<'RefreshFamilyId'>(raw);
