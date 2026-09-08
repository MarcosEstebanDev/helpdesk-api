/**
 * Política de rate limiting de los endpoints de autenticación (ADR-0013).
 *
 * Son constantes y no configuración por entorno a propósito: un límite de
 * seguridad que se puede aflojar con una variable de entorno acaba aflojado.
 * Los tests que necesitan saltárselo sustituyen el guard, no el número.
 *
 * `ttl` en milisegundos.
 */
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Login: el endpoint que un atacante usa para probar passwords. */
export const LOGIN_THROTTLE = { limit: 5, ttl: 15 * MINUTE } as const;

/** Registro: crear organizaciones es raro y caro (provisioning + argon2). */
export const REGISTER_THROTTLE = { limit: 5, ttl: HOUR } as const;

/**
 * Refresh: un cliente legítimo rota cada ~15 min, pero puede haber varias
 * pestañas abiertas. Generoso comparado con login, y aun así acotado.
 */
export const REFRESH_THROTTLE = { limit: 30, ttl: 15 * MINUTE } as const;

/** Límite global del resto de la API, como red de seguridad. */
export const GLOBAL_THROTTLE = { limit: 300, ttl: MINUTE } as const;
