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
