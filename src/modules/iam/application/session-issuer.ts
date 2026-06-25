import {
  RefreshFamilyId,
  RefreshTokenId,
  TenantId,
  UserId,
} from '../domain/ids';
import { Role } from '../domain/role';
import { RefreshToken } from '../domain/entities/refresh-token.entity';
import { Clock } from '../domain/ports/clock';
import { IdGenerator } from '../domain/ports/id-generator';
import { RefreshTokenRepository } from '../domain/ports/refresh-token.repository';
import { TokenService } from '../domain/ports/token.service';
import { AuthTokens } from './auth-tokens';

/**
 * Servicio de aplicación que mintea una sesión: firma el access token, emite un
 * refresh token y lo persiste. Centraliza la lógica que comparten register, login
 * y refresh, y la decisión de "familia nueva" (login/register) vs "misma familia"
 * (rotación en refresh).
 */
export class SessionIssuer {
  constructor(
    private readonly tokenService: TokenService,
    private readonly refreshTokens: RefreshTokenRepository,
    private readonly idGenerator: IdGenerator,
    private readonly clock: Clock,
  ) {}

  /**
   * @param familyId si se omite, abre una familia nueva (login/register); si se
   *                 pasa, encadena la rotación dentro de la familia existente.
   */
  async issue(params: {
    userId: UserId;
    tenantId: TenantId;
    role: Role;
    familyId?: RefreshFamilyId;
  }): Promise<AuthTokens> {
    const familyId =
      params.familyId ?? RefreshFamilyId(this.idGenerator.uuid());

    const accessToken = await this.tokenService.signAccessToken({
      userId: params.userId,
      tenantId: params.tenantId,
      role: params.role,
    });

    const issued = await this.tokenService.issueRefreshToken({
      userId: params.userId,
      tenantId: params.tenantId,
      familyId,
    });

    const refreshToken = RefreshToken.issue({
      id: RefreshTokenId(issued.tokenId),
      tenantId: params.tenantId,
      userId: params.userId,
      familyId,
      tokenHash: issued.tokenHash,
      expiresAt: issued.expiresAt,
      now: this.clock.now(),
    });
    await this.refreshTokens.save(refreshToken);

    return {
      accessToken,
      refreshToken: issued.token,
      refreshTokenExpiresAt: issued.expiresAt,
    };
  }
}
