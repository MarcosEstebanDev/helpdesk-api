/**
 * Paso previo al despliegue en un Postgres gestionado (ADR-0026). Corre en el
 * Pre-Deploy Command de Railway, con el superusuario que da la plataforma:
 *
 *     node dist/deploy/prepare-database.js owner   # antes de migrar
 *     node dist/deploy/prepare-database.js app     # después de migrar
 *
 * `owner` deja listo el rol `helpdesk` que usan las migraciones; `app` rota la
 * contraseña de `helpdesk_app`, que la migración crea con un valor público.
 * Dos invocaciones y no una porque `helpdesk_app` no existe hasta que corre la
 * primera migración.
 *
 * Usa Prisma y no `psql` porque la imagen de la API no trae cliente de Postgres,
 * y no hace falta sumarlo para dos sentencias.
 */
import { PrismaClient } from '@prisma/client';
import { appRoleStatement, ownerRoleStatement } from './database-roles';

const PASOS = {
  owner: () => ownerRoleStatement(process.env.OWNER_DB_PASSWORD ?? ''),
  app: () => appRoleStatement(process.env.APP_DB_PASSWORD ?? ''),
} as const;

async function main(): Promise<void> {
  const paso = process.argv[2];
  if (paso !== 'owner' && paso !== 'app') {
    throw new Error('Uso: prepare-database.js <owner|app>');
  }

  const url = process.env.DATABASE_SUPERUSER_URL;
  if (!url) {
    throw new Error('Falta DATABASE_SUPERUSER_URL.');
  }

  // Se construye ANTES de conectar: una contraseña inválida no debe llegar ni
  // a abrir la conexión.
  const sql = PASOS[paso]();

  const prisma = new PrismaClient({ datasourceUrl: url });
  try {
    await prisma.$executeRawUnsafe(sql);
    // Sin la contraseña en el log, ni siquiera por error.
    console.log(`prepare-database: paso "${paso}" aplicado.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(
    'prepare-database: falló.',
    error instanceof Error ? error.message : error,
  );
  process.exit(1);
});
