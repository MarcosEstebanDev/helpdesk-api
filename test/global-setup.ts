import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';

/**
 * Precondición de los tests e2e.
 *
 * Los e2e corren contra un Postgres REAL (Row-Level Security no se puede
 * mockear, ver ADR-0003). Si no está levantado, Prisma falla con un error de
 * conexión críptico que no dice qué hacer. Este setup lo convierte en una
 * instrucción concreta.
 *
 * Corre ANTES de que Nest cargue `ConfigModule`, así que `process.env` todavía
 * no tiene las variables del `.env`: hay que leerlo a mano. Se hace con un
 * parser mínimo en vez de añadir `dotenv` como dependencia directa.
 */

const AYUDA = `
  Los tests e2e necesitan PostgreSQL corriendo.

    1. docker compose -f infra/docker-compose.yml up -d
    2. pnpm prisma:deploy
    3. pnpm test:e2e
`;

/** Parser mínimo de .env: KEY=valor, ignorando comentarios y líneas vacías. */
function loadEnvFile(path: string): void {
  let contents: string;
  try {
    contents = readFileSync(path, 'utf8');
  } catch {
    return; // en CI las variables vienen del entorno, no de un fichero
  }

  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    const separator = trimmed.indexOf('=');
    if (separator === -1) continue;

    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    // El entorno real gana sobre el fichero: así el CI puede sobreescribir.
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

export default async function globalSetup(): Promise<void> {
  loadEnvFile(join(__dirname, '..', '.env'));

  if (process.env.DATABASE_URL === undefined) {
    throw new Error(
      `Falta DATABASE_URL. Copiá .env.example a .env y completalo.\n${AYUDA}`,
    );
  }

  const prisma = new PrismaClient();
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    throw new Error(`No se pudo conectar a PostgreSQL.\n${AYUDA}`);
  }

  try {
    // No basta con conectar: si faltan las migraciones, los tests fallan más
    // tarde y con peor mensaje. Se comprueba una tabla de la migración MÁS
    // RECIENTE (fase 4), que es lo que delata una base de datos a medio migrar.
    await prisma.$queryRaw`SELECT 1 FROM ticket_counters LIMIT 1`;
  } catch {
    throw new Error(
      `La base de datos existe pero le faltan migraciones.\n\n  Ejecutá: pnpm prisma:deploy\n`,
    );
  } finally {
    await prisma.$disconnect();
  }
}
