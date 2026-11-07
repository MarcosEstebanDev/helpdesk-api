/**
 * SQL de los roles de base de datos para un despliegue gestionado (ADR-0026).
 *
 * `ALTER ROLE ... PASSWORD` no admite parámetros: Postgres no deja enlazar la
 * contraseña como `$1`, así que va escrita dentro del SQL. Por eso este módulo
 * NO escapa nada: exige que la contraseña sea hexadecimal en minúsculas, un
 * alfabeto en el que no existe ningún carácter capaz de cerrar el literal. Una
 * contraseña que no cumpla no llega a convertirse en SQL.
 */

/** Hexadecimal en minúsculas, 32+ caracteres (`openssl rand -hex 24` da 48). */
const SAFE_PASSWORD = /^[0-9a-f]{32,}$/;

/** Nombre que las migraciones asumen para el dueño de las tablas. */
export const OWNER_ROLE = 'helpdesk';
/** Rol con el que corre la API (ADR-0010). */
export const APP_ROLE = 'helpdesk_app';

export function assertSafePassword(
  name: string,
  value: string | undefined,
): string {
  if (value === undefined || value === '') {
    throw new Error(`Falta ${name}.`);
  }
  if (!SAFE_PASSWORD.test(value)) {
    throw new Error(
      `${name} tiene que ser hexadecimal en minúsculas de 32 caracteres o más ` +
        `(generarla con: openssl rand -hex 24).`,
    );
  }
  return value;
}

/**
 * Quién pone el rol dueño (adenda del ADR-0026).
 *
 * - `create`: la plataforma da un superusuario (Railway, una VPS) y el script
 *   crea `helpdesk` con él.
 * - `external`: la plataforma NO da superusuario (Neon: el rol más alto tiene
 *   CREATEROLE pero no SUPERUSER, así que `CREATE ROLE ... SUPERUSER` falla).
 *   `helpdesk` se crea a mano desde la consola del proveedor, y el script solo
 *   comprueba que la conexión de migraciones sea ese rol y pueda crear roles.
 */
export type OwnerMode = 'create' | 'external';

export function parseOwnerMode(value: string | undefined): OwnerMode {
  if (value === undefined || value === '' || value === 'create') {
    return 'create';
  }
  if (value === 'external') {
    return 'external';
  }
  throw new Error(
    `DATABASE_OWNER_MODE tiene que ser "create" o "external" (vino "${value}").`,
  );
}

/**
 * Rol dueño de las tablas, el que corre las migraciones (modo `create`).
 *
 * Las migraciones asumen que se llama `helpdesk` (por ejemplo, `ALTER DEFAULT
 * PRIVILEGES FOR ROLE helpdesk` en la inicial), que es el superusuario del
 * compose local y del CI. En un Postgres gestionado el superusuario tiene otro
 * nombre, así que se crea aquí. SUPERUSER por lo mismo que en local: las
 * migraciones crean roles y funciones `SECURITY DEFINER` y cambian dueños. Esa
 * credencial solo la usa el paso previo al despliegue, nunca la API.
 *
 * Idempotente: si el rol ya existe, solo le fija la contraseña, para que
 * cambiarla en las variables del despliegue baste para rotarla.
 */
export function ownerRoleStatement(password: string): string {
  const pw = assertSafePassword('OWNER_DB_PASSWORD', password);
  return `DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'helpdesk') THEN
    CREATE ROLE helpdesk LOGIN SUPERUSER PASSWORD '${pw}';
  ELSE
    ALTER ROLE helpdesk PASSWORD '${pw}';
  END IF;
END
$$`;
}

/**
 * Rol de la aplicación (sin BYPASSRLS, ADR-0010). La migración inicial lo crea
 * con la contraseña 'helpdesk_app', que es pública en el repo: se rota después
 * de migrar, en cada despliegue.
 *
 * En modo `external` lo ejecuta el propio `helpdesk`: desde Postgres 16, quien
 * crea un rol con CREATEROLE recibe ADMIN OPTION sobre él, y eso basta para
 * cambiarle la contraseña.
 */
export function appRoleStatement(password: string): string {
  const pw = assertSafePassword('APP_DB_PASSWORD', password);
  return `ALTER ROLE helpdesk_app PASSWORD '${pw}'`;
}

/**
 * Roles NOLOGIN dueños de funciones `SECURITY DEFINER` (ADR-0012, 0019, 0021).
 * Las migraciones los crean si faltan y les pasan la función con
 * `ALTER FUNCTION ... OWNER TO`.
 */
export const DEFINER_ROLES = [
  'helpdesk_slug_resolver',
  'helpdesk_outbox_publisher',
  'helpdesk_sla_sweeper',
] as const;

/**
 * Modo `external`, ANTES de migrar. Sin superusuario, `ALTER ... OWNER TO x`
 * exige que `x` tenga CREATE en el esquema de la función (un superusuario se
 * salta ese chequeo, por eso en local y en CI nunca apareció). Los roles de
 * arriba solo tienen USAGE, así que la segunda migración fallaba con
 * `42501 permission denied for schema public` (ensayo tipo Neon).
 *
 * Se crean aquí —idénticos a como los crean las migraciones, que los saltan si
 * ya existen— y reciben CREATE en `public` SOLO mientras se migra:
 * `definerRolesRevokeStatement` se lo quita en el paso `app` y `verify` falla si
 * alguno lo conserva. Las migraciones aplicadas no se tocan (ADR-0026, dec. 1).
 */
export function definerRolesGrantStatement(): string {
  const creates = DEFINER_ROLES.map(
    (
      role,
    ) => `  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
    CREATE ROLE ${role} NOLOGIN;
  END IF;`,
  ).join('\n');
  return `DO $$
BEGIN
${creates}
  GRANT CREATE ON SCHEMA public TO ${DEFINER_ROLES.join(', ')};
END
$$`;
}

/** Modo `external`, DESPUÉS de migrar: retira el CREATE temporal. */
export function definerRolesRevokeStatement(): string {
  return `REVOKE CREATE ON SCHEMA public FROM ${DEFINER_ROLES.join(', ')}`;
}

/** Roles que NO deben poder crear objetos en `public` una vez migrado. */
export const SCHEMA_CREATE_QUERY = `SELECT r.rolname AS "name", has_schema_privilege(r.oid, 'public', 'CREATE') AS "canCreate"
FROM pg_roles r
WHERE r.rolname IN ('helpdesk_app', ${DEFINER_ROLES.map((r) => `'${r}'`).join(', ')})
ORDER BY r.rolname`;

export interface SchemaCreateRow {
  name: string;
  canCreate: boolean;
}

/** Atributos del rol con el que se está conectado. */
export const CURRENT_ROLE_QUERY = `SELECT rolname AS "name", rolsuper AS "superuser", rolcreaterole AS "createRole"
FROM pg_roles WHERE rolname = current_user`;

export interface RoleRow {
  name: string;
  superuser: boolean;
  createRole: boolean;
}

/**
 * Modo `external`: en vez de crear el dueño, se comprueba que la conexión de
 * migraciones SEA el dueño. Falla con un mensaje que dice qué hacer, antes de
 * que la primera migración falle con uno que no lo dice.
 */
export function assertExternalOwner(row: RoleRow | undefined): void {
  if (row === undefined) {
    throw new Error('No se pudo leer el rol de la conexión de migraciones.');
  }
  if (row.name !== OWNER_ROLE) {
    throw new Error(
      `MIGRATION_DATABASE_URL entra como "${row.name}" y las migraciones ` +
        `asumen el dueño "${OWNER_ROLE}": crear ese rol en la consola del ` +
        `proveedor y usar sus credenciales.`,
    );
  }
  if (!row.superuser && !row.createRole) {
    throw new Error(
      `El rol "${OWNER_ROLE}" necesita CREATEROLE: las migraciones crean ` +
        `helpdesk_app y los roles de las funciones SECURITY DEFINER.`,
    );
  }
}

/**
 * Modo `create`: la conexión tiene que ser SUPERUSER de verdad. Sin esta
 * comprobación, en un Postgres sin superusuario donde `helpdesk` ya existe el
 * paso NO falla: cae en la rama `ALTER ROLE helpdesk PASSWORD` (cambiarse la
 * propia contraseña está permitido) y le pisa en silencio la contraseña que dio
 * la consola del proveedor. Pasó en el ensayo tipo Neon.
 */
export function assertPlatformSuperuser(row: RoleRow | undefined): void {
  if (row === undefined) {
    throw new Error('No se pudo leer el rol de DATABASE_SUPERUSER_URL.');
  }
  if (!row.superuser) {
    throw new Error(
      `DATABASE_SUPERUSER_URL entra como "${row.name}", que no es SUPERUSER. ` +
        `En un Postgres gestionado sin superusuario (Neon) usar ` +
        `DATABASE_OWNER_MODE=external y crear "${OWNER_ROLE}" en la consola.`,
    );
  }
}

/** Atributos del rol de la aplicación. */
export const APP_ROLE_QUERY = `SELECT rolname AS "name", rolsuper AS "superuser", rolbypassrls AS "bypassRls"
FROM pg_roles WHERE rolname = 'helpdesk_app'`;

/** Estado de RLS de cada tabla del esquema, salvo la de Prisma. */
export const TABLES_QUERY = `SELECT c.relname AS "name", c.relrowsecurity AS "rls", c.relforcerowsecurity AS "forceRls",
       pg_get_userbyid(c.relowner) AS "owner"
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname <> '_prisma_migrations'
ORDER BY c.relname`;

export interface AppRoleRow {
  name: string;
  superuser: boolean;
  bypassRls: boolean;
}

export interface TableRow {
  name: string;
  rls: boolean;
  forceRls: boolean;
  owner: string;
}

/**
 * Las garantías del ADR-0010, comprobadas contra la base ya migrada. En un
 * Postgres gestionado no se puede dar por hecho que el rol de la app salga como
 * en local (un proveedor puede regalar atributos a los roles), así que el paso
 * `verify` lo mira después de migrar. Devuelve los problemas; vacío = bien.
 */
export function findSecurityProblems(
  appRole: AppRoleRow | undefined,
  tables: TableRow[],
  schemaCreate: SchemaCreateRow[] = [],
): string[] {
  const problems: string[] = [];
  for (const row of schemaCreate) {
    if (row.canCreate) {
      problems.push(`${row.name} puede crear objetos en el esquema public`);
    }
  }
  if (appRole === undefined) {
    problems.push(
      `no existe el rol ${APP_ROLE} (¿se corrieron las migraciones?)`,
    );
  } else {
    if (appRole.superuser) problems.push(`${APP_ROLE} es SUPERUSER`);
    if (appRole.bypassRls) problems.push(`${APP_ROLE} tiene BYPASSRLS`);
  }
  if (tables.length === 0) {
    problems.push('no hay tablas en el esquema public');
  }
  for (const table of tables) {
    if (!table.rls) problems.push(`${table.name}: RLS deshabilitado`);
    if (!table.forceRls) problems.push(`${table.name}: sin FORCE RLS`);
    if (table.owner === APP_ROLE) {
      problems.push(`${table.name}: su dueño es ${APP_ROLE}`);
    }
  }
  return problems;
}

export type Step = 'owner' | 'app' | 'verify';

/**
 * Con qué conexión corre cada paso. En modo `external` no hay superusuario:
 * todo va con la de migraciones, que es el dueño.
 */
export function connectionFor(
  step: Step,
  mode: OwnerMode,
  env: NodeJS.ProcessEnv,
): string {
  const useSuperuser = mode === 'create' && step !== 'verify';
  const name = useSuperuser
    ? 'DATABASE_SUPERUSER_URL'
    : 'MIGRATION_DATABASE_URL';
  const url = env[name];
  if (url === undefined || url === '') {
    throw new Error(`Falta ${name}.`);
  }
  return url;
}
