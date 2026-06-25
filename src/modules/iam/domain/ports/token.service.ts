import { Role } from '../role';

export interface AccessTokenClaims {
  userId: string;
  tenantId: string;
  role: Role;
}

export interface RefreshTokenClaims {
  userId: string;
  tenantId: string;
  familyId: string;
  /** jti — identifica al token individual dentro de la familia. */
  tokenId: string;
}

export interface IssuedRefreshToken {
  /** JWT firmado a entregar al cliente (cookie httpOnly). */
  token: string;
  /** Hash del token a persistir (nunca se guarda el valor en claro). */
  tokenHash: string;
  tokenId: string;
  expiresAt: Date;
}

/**
 * Puerto de emisión/verificación de tokens (JWT en 2c).
 *
 * El refresh token es un JWT FIRMADO que carga `tenantId`: así, en `/auth/refresh`
 * podemos conocer el tenant (y por ende fijar el contexto RLS) sin un lookup previo
 * a la DB. La detección de reuse se hace contra el hash persistido.
 */
export interface TokenService {
  signAccessToken(claims: AccessTokenClaims): Promise<string>;
  issueRefreshToken(input: {
    userId: string;
    tenantId: string;
    familyId: string;
  }): Promise<IssuedRefreshToken>;
  verifyRefreshToken(token: string): Promise<RefreshTokenClaims | null>;
  /** Hash determinístico del token, para buscarlo en el repositorio. */
  hashRefreshToken(token: string): string;
}

export const TOKEN_SERVICE = Symbol('iam.TokenService');
