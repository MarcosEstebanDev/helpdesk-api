import { z } from 'zod';

/**
 * Single source of truth for environment configuration. Validated at boot:
 * if a required variable is missing or malformed the process fails fast with
 * a readable message, instead of blowing up at runtime deep in a request.
 *
 * DATABASE_URL is required from Phase 2 on (the app talks to Postgres at boot).
 * MIGRATION_DATABASE_URL is only needed to RUN migrations (`prisma migrate`), not
 * at runtime, so it stays optional. REDIS_URL becomes required in Phase 5.
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
  REDIS_URL: z.string().min(1).optional(),
  // Secretos JWT (ADR-0011). Separados a propósito: un access token filtrado no
  // permite forjar refresh tokens. Mínimo 32 chars para que HS256 tenga margen.
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  // TTLs en formato de `ms` (ej. '15m', '30d') — los consume @nestjs/jwt.
  JWT_ACCESS_TTL: z.string().min(1).default('15m'),
  JWT_REFRESH_TTL: z.string().min(1).default('30d'),
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
