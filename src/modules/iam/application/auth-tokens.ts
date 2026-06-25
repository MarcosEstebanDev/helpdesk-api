/**
 * Resultado de una autenticación. El controller (2c) entrega `accessToken` en el
 * body y `refreshToken` en una cookie httpOnly (con expiración `refreshTokenExpiresAt`).
 */
export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
}
