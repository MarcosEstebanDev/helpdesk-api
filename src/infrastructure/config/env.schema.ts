import { z } from 'zod';

/**
 * Single source of truth for environment configuration. Validated at boot:
 * if a required variable is missing or malformed the process fails fast with
 * a readable message, instead of blowing up at runtime deep in a request.
 *
 * DATABASE_URL is required from Phase 2 on (the app talks to Postgres at boot).
 * MIGRATION_DATABASE_URL is only needed to RUN migrations (`prisma migrate`), not
 * at runtime, so it stays optional. REDIS_URL is required from Phase 5 on: sin
 * Redis no hay colas, y arrancar sin ellas dejaría los eventos del outbox
 * acumulándose en silencio — mejor fallar en el arranque.
 */
export const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  // Rol de aplicación RESTRINGIDO (sin BYPASSRLS) — RLS siempre aplica.
  DATABASE_URL: z.string().min(1),
  // Rol owner/superusuario — solo para `prisma migrate` (DDL). No usar en runtime.
  MIGRATION_DATABASE_URL: z.string().min(1).optional(),
  REDIS_URL: z.string().min(1),
  // Publicador del outbox y worker (ADR-0019).
  //
  // `WORKER_ENABLED` permite arrancar la API sin consumir colas. Hoy el worker
  // vive en el MISMO proceso que la API; el día que se separe, el despliegue web
  // arrancará con 0 y el de workers con 1, sin tocar una línea de código. Los
  // tests e2e también lo apagan para dirigir el publicador a mano.
  WORKER_ENABLED: z
    .enum(['0', '1'])
    .default('1')
    .transform((value) => value === '1'),
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(1000),
  OUTBOX_BATCH_SIZE: z.coerce.number().int().positive().max(1000).default(100),
  // Tras estos intentos fallidos de ENCOLAR, el mensaje deja de reclamarse para
  // que uno envenenado no frene a los que van detrás.
  OUTBOX_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  // Reintentos del CONSUMIDOR antes de mandar el job a la dead-letter queue.
  QUEUE_JOB_ATTEMPTS: z.coerce.number().int().positive().default(5),
  QUEUE_BACKOFF_MS: z.coerce.number().int().positive().default(1000),
  // Barrido de SLA (ADR-0021). El intervalo fija la PRECISIÓN con la que se
  // detecta un incumplimiento; con objetivos medidos en horas, 30s sobra.
  SLA_SWEEP_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
  SLA_SWEEP_BATCH_SIZE: z.coerce
    .number()
    .int()
    .positive()
    .max(1000)
    .default(100),
  // Secretos JWT (ADR-0011). Separados a propósito: un access token filtrado no
  // permite forjar refresh tokens. Mínimo 32 chars para que HS256 tenga margen.
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  // TTLs en formato de `ms` (ej. '15m', '30d') — los consume @nestjs/jwt.
  JWT_ACCESS_TTL: z.string().min(1).default('15m'),
  JWT_REFRESH_TTL: z.string().min(1).default('30d'),
  // Nivel de log (ADR-0024). En producción `info`: `debug` en un sistema con
  // colas escupe una línea por job y ahoga lo que importa.
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),
  // Orígenes del navegador autorizados, separados por coma.
  //
  // El frontend manda `credentials: 'include'` para que viaje la cookie httpOnly
  // del refresh, y el navegador SOLO acepta esa respuesta si el servidor
  // devuelve el origen EXACTO junto a `Access-Control-Allow-Credentials`. Con el
  // comodín `*` la respuesta se descarta entera, así que no se puede permitir
  // "cualquier origen" y tener cookies a la vez: hay que enumerarlos.
  CORS_ORIGINS: z
    .string()
    .min(1)
    .default('http://localhost:3001')
    .transform((valor) =>
      valor
        .split(',')
        .map((origen) => origen.trim())
        .filter((origen) => origen !== ''),
    ),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(config);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment variables:\n${issues}`);
  }
  return parsed.data;
}
