import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { Env } from '../../../../infrastructure/config/env.schema';
import { Role, isRole } from '../../domain/role';

export interface AuthPrincipal {
  userId: string;
  tenantId: string;
  role: Role;
}

/**
 * Verifica el access token y devuelve el principal, o `null` si el token falta,
 * está mal firmado, expiró o tiene una forma inesperada. No lanza: quien decide
 * si eso es un 401 es el guard, no el verificador.
 */
@Injectable()
export class AccessTokenVerifier {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async verify(token: string): Promise<AuthPrincipal | null> {
    try {
      const payload = await this.jwt.verifyAsync<Record<string, unknown>>(
        token,
        { secret: this.config.get('JWT_ACCESS_SECRET', { infer: true }) },
      );

      const { sub, tenantId, role } = payload;
      if (
        typeof sub !== 'string' ||
        typeof tenantId !== 'string' ||
        typeof role !== 'string' ||
        !isRole(role)
      ) {
        return null;
      }
      return { userId: sub, tenantId, role };
    } catch {
      return null;
    }
  }

  /** Extrae el token de una cabecera `Authorization: Bearer <token>`. */
  static extractBearer(header: string | undefined): string | null {
    if (header === undefined) return null;
    const [scheme, token] = header.split(' ');
    return scheme?.toLowerCase() === 'bearer' && token ? token : null;
  }
}
