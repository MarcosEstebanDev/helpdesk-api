import { RefreshFamilyId, RefreshTokenId, TenantId } from '../ids';
import { RefreshToken } from '../entities/refresh-token.entity';

/**
 * Puerto de persistencia de refresh tokens. Soporta rotación (markRotated) y la
 * revocación de toda una familia ante reuse o logout.
 */
export interface RefreshTokenRepository {
  save(token: RefreshToken): Promise<void>;
  findByHash(
    tenantId: TenantId,
    tokenHash: string,
  ): Promise<RefreshToken | null>;
  markRotated(
    tenantId: TenantId,
    id: RefreshTokenId,
    rotatedAt: Date,
  ): Promise<void>;
  revokeFamily(
    tenantId: TenantId,
    familyId: RefreshFamilyId,
    revokedAt: Date,
  ): Promise<void>;
}

export const REFRESH_TOKEN_REPOSITORY = Symbol('iam.RefreshTokenRepository');
