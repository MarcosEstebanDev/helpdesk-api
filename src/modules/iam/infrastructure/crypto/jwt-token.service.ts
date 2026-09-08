import { createHash, randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { Env } from '../../../../infrastructure/config/env.schema';
import {
  AccessTokenClaims,
  IssuedRefreshToken,
  RefreshTokenClaims,
  TokenService,
} from '../../domain/ports/token.service';
import { isRole } from '../../domain/role';

/** Forma del payload que firmamos. `sub` es el estándar JWT para el sujeto. */
interface RefreshPayload {
  sub: string;
  tenantId: string;
  familyId: string;
  jti: string;
  exp: number;
}

/**
 * Adapter de {@link TokenService} con JWT (ADR-0011).
 *
 * Dos secretos separados a propósito: un access token filtrado no permite forjar
 * refresh tokens. El refresh carga `tenantId` para poder fijar el contexto RLS
 * en `/auth/refresh` sin un lookup previo a la base de datos.
 */
@Injectable()
export class JwtTokenService implements TokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async signAccessToken(claims: AccessTokenClaims): Promise<string> {
    return this.jwt.signAsync(
      { sub: claims.userId, tenantId: claims.tenantId, role: claims.role },
      {
        secret: this.config.get('JWT_ACCESS_SECRET', { infer: true }),
        expiresIn: this.config.get('JWT_ACCESS_TTL', { infer: true }),
      },
    );
  }

  async issueRefreshToken(input: {
    userId: string;
    tenantId: string;
    familyId: string;
  }): Promise<IssuedRefreshToken> {
    // `jti` identifica al token individual dentro de la familia y es el id con
    // el que se persiste, de modo que token firmado y fila de BD comparten id.
    const tokenId = randomUUID();

    const token = await this.jwt.signAsync(
      {
        sub: input.userId,
        tenantId: input.tenantId,
        familyId: input.familyId,
        jti: tokenId,
      },
      {
        secret: this.config.get('JWT_REFRESH_SECRET', { infer: true }),
        expiresIn: this.config.get('JWT_REFRESH_TTL', { infer: true }),
      },
    );

    // La expiración la decide el propio JWT: leerla del token (en vez de
    // recalcularla) garantiza que la fila de BD y el token nunca discrepen.
    const decoded = this.jwt.decode<RefreshPayload | null>(token);
    if (decoded === null) {
      throw new Error(
        'No se pudo decodificar el refresh token recién firmado.',
      );
    }

    return {
      token,
      tokenHash: this.hashRefreshToken(token),
      tokenId,
      expiresAt: new Date(decoded.exp * 1000),
    };
  }

  async verifyRefreshToken(token: string): Promise<RefreshTokenClaims | null> {
    try {
      const payload = await this.jwt.verifyAsync<RefreshPayload>(token, {
        secret: this.config.get('JWT_REFRESH_SECRET', { infer: true }),
      });

      // Un token con firma válida pero forma inesperada es tan inválido como
      // uno mal firmado: no confiamos en el payload solo porque verifique.
      if (
        typeof payload.sub !== 'string' ||
        typeof payload.tenantId !== 'string' ||
        typeof payload.familyId !== 'string' ||
        typeof payload.jti !== 'string'
      ) {
        return null;
      }

      return {
        userId: payload.sub,
        tenantId: payload.tenantId,
        familyId: payload.familyId,
        tokenId: payload.jti,
      };
    } catch {
      // Firma inválida, expirado o malformado: para el caso de uso es lo mismo.
      return null;
    }
  }

  /**
   * SHA-256, no argon2. Un refresh token es un JWT de alta entropía, no un
   * password adivinable: no hace falta un hash lento, y sí uno determinista y
   * rápido para poder buscarlo por igualdad en la base de datos.
   */
  hashRefreshToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}

/** Verifica que el rol que viaja en un access token sea uno conocido. */
export const parseRole = (raw: unknown): string | null =>
  typeof raw === 'string' && isRole(raw) ? raw : null;
