/**
 * Pasos de base de datos de un despliegue gestionado (ADR-0026 y su adenda).
 *
 *     node dist/deploy/prepare-database.js owner    # antes de migrar
 *     node dist/deploy/prepare-database.js app      # después de migrar
 *     node dist/deploy/prepare-database.js verify   # comprueba el ADR-0010
 *
 * `owner` deja listo el rol `helpdesk` que usan las migraciones; `app` rota la
 * contraseña de `helpdesk_app`, que la migración crea con un valor público;
 * `verify` comprueba que `helpdesk_app` no tenga SUPERUSER ni BYPASSRLS y que
 * todas las tablas tengan RLS con FORCE. Pasos separados porque `helpdesk_app`
 * no existe hasta que corre la primera migración.
 *
 * `DATABASE_OWNER_MODE` elige quién pone el dueño:
 * - `create` (por defecto, Railway/VPS): `owner` y `app` usan el superusuario
 *   de la plataforma (`DATABASE_SUPERUSER_URL`).
 * - `external` (Neon y cualquier Postgres sin SUPERUSER): `helpdesk` se crea a
 *   mano en la consola del proveedor; `owner` solo comprueba que
 *   `MIGRATION_DATABASE_URL` entre como él con CREATEROLE y da CREATE temporal
 *   en `public` a los roles dueños de funciones SECURITY DEFINER (sin
 *   superusuario, `ALTER ... OWNER TO` lo exige); `app` corre con esa misma
 *   conexión y se lo retira.
 *
 * Usa Prisma y no `psql` porque la imagen de la API no trae cliente de Postgres,
 * y no hace falta sumarlo para tres pasos.
 */
import { PrismaClient } from '@prisma/client';
import {
  APP_ROLE_QUERY,
  type AppRoleRow,
  appRoleStatement,
  assertExternalOwner,
  assertPlatformSuperuser,
  connectionFor,
  CURRENT_ROLE_QUERY,
  definerRolesGrantStatement,
  definerRolesRevokeStatement,
  findSecurityProblems,
  ownerRoleStatement,
  parseOwnerMode,
  type OwnerMode,
  type RoleRow,
  SCHEMA_CREATE_QUERY,
  type SchemaCreateRow,
  type Step,
  TABLES_QUERY,
  type TableRow,
} from './database-roles';

function parseStep(value: string | undefined): Step {
  if (value === 'owner' || value === 'app' || value === 'verify') {
    return value;
  }
  throw new Error('Uso: prepare-database.js <owner|app|verify>');
}

async function run(
  prisma: PrismaClient,
  step: Step,
  mode: OwnerMode,
): Promise<void> {
  if (step === 'owner' && mode === 'create') {
    const rows = await prisma.$queryRawUnsafe<RoleRow[]>(CURRENT_ROLE_QUERY);
    assertPlatformSuperuser(rows[0]);
    await prisma.$executeRawUnsafe(
      ownerRoleStatement(process.env.OWNER_DB_PASSWORD ?? ''),
    );
    return;
  }
  if (step === 'owner') {
    const rows = await prisma.$queryRawUnsafe<RoleRow[]>(CURRENT_ROLE_QUERY);
    assertExternalOwner(rows[0]);
    // Sin superusuario, los ALTER ... OWNER TO de las migraciones lo necesitan.
    await prisma.$executeRawUnsafe(definerRolesGrantStatement());
    return;
  }
  if (step === 'app') {
    await prisma.$executeRawUnsafe(
      appRoleStatement(process.env.APP_DB_PASSWORD ?? ''),
    );
    if (mode === 'external') {
      await prisma.$executeRawUnsafe(definerRolesRevokeStatement());
    }
    return;
  }
  const appRole = await prisma.$queryRawUnsafe<AppRoleRow[]>(APP_ROLE_QUERY);
  const tables = await prisma.$queryRawUnsafe<TableRow[]>(TABLES_QUERY);
  const schemaCreate =
    await prisma.$queryRawUnsafe<SchemaCreateRow[]>(SCHEMA_CREATE_QUERY);
  const problems = findSecurityProblems(appRole[0], tables, schemaCreate);
  if (problems.length > 0) {
    throw new Error(`garantías de RLS rotas:\n  - ${problems.join('\n  - ')}`);
  }
  console.log(
    `prepare-database: ${tables.length} tablas con RLS + FORCE; ` +
      'helpdesk_app sin SUPERUSER ni BYPASSRLS.',
  );
}

async function main(): Promise<void> {
  const step = parseStep(process.argv[2]);
  const mode = parseOwnerMode(process.env.DATABASE_OWNER_MODE);
  const url = connectionFor(step, mode, process.env);

  // Las contraseñas se validan ANTES de conectar: una inválida no debe llegar
  // ni a abrir la conexión.
  if (step === 'owner' && mode === 'create') {
    ownerRoleStatement(process.env.OWNER_DB_PASSWORD ?? '');
  }
  if (step === 'app') {
    appRoleStatement(process.env.APP_DB_PASSWORD ?? '');
  }

  const prisma = new PrismaClient({ datasourceUrl: url });
  try {
    await run(prisma, step, mode);
    // Sin la contraseña en el log, ni siquiera por error.
    console.log(`prepare-database: paso "${step}" (${mode}) aplicado.`);
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
