/**
 * Fija `REFRESH_COOKIE_PATH` ANTES de que se cargue `AppModule` (mismo motivo
 * que `trust-proxy-env.ts`: `ConfigModule.forRoot` valida al importarse).
 *
 * Es el valor de producción cuando el front sirve la API detrás de su proxy
 * `/api/*` (ADR-0035).
 */
process.env.REFRESH_COOKIE_PATH = '/api/auth';
process.env.THROTTLE_SKIP = '1';
