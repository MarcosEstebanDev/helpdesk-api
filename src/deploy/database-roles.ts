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
 * Rol dueño de las tablas, el que corre las migraciones.
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
 */
export function appRoleStatement(password: string): string {
  const pw = assertSafePassword('APP_DB_PASSWORD', password);
  return `ALTER ROLE helpdesk_app PASSWORD '${pw}'`;
}
