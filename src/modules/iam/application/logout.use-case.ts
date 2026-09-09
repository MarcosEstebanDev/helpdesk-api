import { Clock, Result, ok } from '../../../shared-kernel';
import { TenantId } from '../domain/ids';
import { IamError } from '../domain/errors';
import { RefreshTokenRepository } from '../domain/ports/refresh-token.repository';
import { TokenService } from '../domain/ports/token.service';

export interface LogoutInput {
  refreshToken: string;
}

/**
 * Cierra la sesión revocando la FAMILIA del refresh token presentado (todas las
 * rotaciones encadenadas). Es idempotente: un token inválido o ya revocado no es
 * un error: simplemente no hay nada que revocar.
 */
export class Logout {
  constructor(
    private readonly tokenService: TokenService,
    private readonly refreshTokens: RefreshTokenRepository,
    private readonly clock: Clock,
  ) {}

  async execute(input: LogoutInput): Promise<Result<void, IamError>> {
    const claims = await this.tokenService.verifyRefreshToken(
      input.refreshToken,
    );
    if (claims === null) {
      return ok(undefined);
    }

    const tenantId = TenantId(claims.tenantId);
    const tokenHash = this.tokenService.hashRefreshToken(input.refreshToken);
    const stored = await this.refreshTokens.findByHash(tenantId, tokenHash);
    if (stored !== null) {
      await this.refreshTokens.revokeFamily(
        tenantId,
        stored.familyId,
        this.clock.now(),
      );
    }
    return ok(undefined);
  }
}
