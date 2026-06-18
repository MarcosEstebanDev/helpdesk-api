import { z } from 'zod';

/**
 * Single source of truth for environment configuration. Validated at boot:
 * if a required variable is missing or malformed the process fails fast with
 * a readable message, instead of blowing up at runtime deep in a request.
 *
 * DATABASE_URL / REDIS_URL are optional in Phase 1 and become required in
 * their respective phases (2 and 5).
 */
export const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1).optional(),
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
