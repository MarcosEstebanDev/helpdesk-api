import { Clock, Result, err, ok } from '../../../shared-kernel';
import { TenantId } from '../domain/ids';
import {
  IamError,
  InvalidCredentialsError,
  RefreshTokenInvalidError,
  RefreshTokenReuseError,
} from '../domain/errors';
import { MembershipRepository } from '../domain/ports/membership.repository';
import { RefreshTokenRepository } from '../domain/ports/refresh-token.repository';
import { TokenService } from '../domain/ports/token.service';
import { AuthTokens } from './auth-tokens';
import { SessionIssuer } from './session-issuer';

export interface RefreshTokensInput {
  refreshToken: string;
}

/**
 * Rotación de refresh tokens con detección de reuse (ADR-0011):
 * - Verifica la firma del refresh (de ahí sale el tenant → contexto RLS).
 * - Si el token presentado ya estaba rotado/revocado ⇒ robo: se revoca la FAMILIA
 *   entera y se rechaza.
 * - Si es válido y vigente: se marca rotado y se emite uno nuevo en la MISMA familia,
 *   junto con un access token fresco (rol re-leído del membership por si cambió).
 */
export class RefreshTokens {
  constructor(
    private readonly tokenService: TokenService,
    private readonly refreshTokens: RefreshTokenRepository,
    private readonly memberships: MembershipRepository,
    private readonly clock: Clock,
    private readonly sessionIssuer: SessionIssuer,
  ) {}

  async execute(
    input: RefreshTokensInput,
  ): Promise<Result<AuthTokens, IamError>> {
    const claims = await this.tokenService.verifyRefreshToken(
      input.refreshToken,
    );
    if (claims === null) {
      return err(new RefreshTokenInvalidError());
    }

    const tenantId = TenantId(claims.tenantId);
    const tokenHash = this.tokenService.hashRefreshToken(input.refreshToken);
    const stored = await this.refreshTokens.findByHash(tenantId, tokenHash);
    if (stored === null) {
      return err(new RefreshTokenInvalidError());
    }

    const now = this.clock.now();

    if (stored.isSpent()) {
      // Reuse de un token ya rotado/revocado: revocar toda la familia.
      await this.refreshTokens.revokeFamily(tenantId, stored.familyId, now);
      return err(new RefreshTokenReuseError());
    }

    if (stored.isExpired(now)) {
      return err(new RefreshTokenInvalidError());
    }

    const membership = await this.memberships.findByUserId(
      tenantId,
      stored.userId,
    );
    if (membership === null) {
      return err(new InvalidCredentialsError());
    }

    // Rota: marca el actual como usado y emite uno nuevo en la misma familia.
    await this.refreshTokens.markRotated(tenantId, stored.id, now);
    const tokens = await this.sessionIssuer.issue({
      userId: stored.userId,
      tenantId,
      role: membership.role,
      familyId: stored.familyId,
    });
    return ok(tokens);
  }
}
