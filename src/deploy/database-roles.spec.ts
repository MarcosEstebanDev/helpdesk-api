import {
  appRoleStatement,
  assertExternalOwner,
  assertPlatformSuperuser,
  assertSafePassword,
  connectionFor,
  DEFINER_ROLES,
  definerRolesGrantStatement,
  definerRolesRevokeStatement,
  findSecurityProblems,
  ownerRoleStatement,
  parseOwnerMode,
  type TableRow,
} from './database-roles';

const HEX_48 = 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0a1b2c3d4';

describe('assertSafePassword', () => {
  it('acepta hexadecimal de 32 caracteres o más', () => {
    expect(() => assertSafePassword('APP_DB_PASSWORD', HEX_48)).not.toThrow();
  });

  it('rechaza una contraseña ausente', () => {
    expect(() => assertSafePassword('APP_DB_PASSWORD', undefined)).toThrow(
      /APP_DB_PASSWORD/,
    );
  });

  it('rechaza una contraseña corta', () => {
    expect(() => assertSafePassword('APP_DB_PASSWORD', 'abc123')).toThrow(/32/);
  });

  it.each([
    ['con comilla: el literal SQL se cerraría', `${HEX_48}'; DROP ROLE x; --`],
    ['con caracteres fuera del hexadecimal', `${HEX_48}zz`],
    ['con mayúsculas', HEX_48.toUpperCase()],
  ])('rechaza una contraseña %s', (_caso, password) => {
    expect(() => assertSafePassword('APP_DB_PASSWORD', password)).toThrow();
  });
});

describe('ownerRoleStatement', () => {
  it('crea el rol dueño si falta y, si existe, solo le fija la contraseña', () => {
    const sql = ownerRoleStatement(HEX_48);

    expect(sql).toContain("rolname = 'helpdesk'");
    expect(sql).toContain(
      `CREATE ROLE helpdesk LOGIN SUPERUSER PASSWORD '${HEX_48}'`,
    );
    expect(sql).toContain(`ALTER ROLE helpdesk PASSWORD '${HEX_48}'`);
  });

  it('no construye SQL con una contraseña insegura', () => {
    expect(() => ownerRoleStatement("x'")).toThrow();
  });
});

describe('appRoleStatement', () => {
  it('rota la contraseña del rol de aplicación', () => {
    expect(appRoleStatement(HEX_48)).toBe(
      `ALTER ROLE helpdesk_app PASSWORD '${HEX_48}'`,
    );
  });

  it('no construye SQL con una contraseña insegura', () => {
    expect(() => appRoleStatement("x'")).toThrow();
  });
});

describe('parseOwnerMode', () => {
  it('por defecto crea el dueño, como en Railway y en la VPS', () => {
    expect(parseOwnerMode(undefined)).toBe('create');
    expect(parseOwnerMode('')).toBe('create');
    expect(parseOwnerMode('create')).toBe('create');
  });

  it('acepta el modo para un Postgres sin SUPERUSER', () => {
    expect(parseOwnerMode('external')).toBe('external');
  });

  it('rechaza un valor desconocido en vez de caer al modo por defecto', () => {
    expect(() => parseOwnerMode('neon')).toThrow(/DATABASE_OWNER_MODE/);
  });
});

describe('assertExternalOwner', () => {
  const owner = { name: 'helpdesk', superuser: false, createRole: true };

  it('acepta a helpdesk con CREATEROLE aunque no sea SUPERUSER (Neon)', () => {
    expect(() => assertExternalOwner(owner)).not.toThrow();
  });

  it('rechaza conectarse con otro rol: las migraciones asumen helpdesk', () => {
    expect(() =>
      assertExternalOwner({ ...owner, name: 'neondb_owner' }),
    ).toThrow(/neondb_owner/);
  });

  it('rechaza un dueño que no puede crear roles', () => {
    expect(() => assertExternalOwner({ ...owner, createRole: false })).toThrow(
      /CREATEROLE/,
    );
  });

  it('rechaza si no se pudo leer el rol', () => {
    expect(() => assertExternalOwner(undefined)).toThrow();
  });
});

describe('assertPlatformSuperuser', () => {
  it('acepta el superusuario de la plataforma (Railway: postgres)', () => {
    expect(() =>
      assertPlatformSuperuser({
        name: 'postgres',
        superuser: true,
        createRole: true,
      }),
    ).not.toThrow();
  });

  it('rechaza un rol con solo CREATEROLE y sugiere el modo external', () => {
    // Sin esto, con `helpdesk` ya creado el paso "funcionaba" y le pisaba la
    // contraseña de la consola de Neon.
    expect(() =>
      assertPlatformSuperuser({
        name: 'helpdesk',
        superuser: false,
        createRole: true,
      }),
    ).toThrow(/DATABASE_OWNER_MODE=external/);
  });

  it('rechaza si no se pudo leer el rol', () => {
    expect(() => assertPlatformSuperuser(undefined)).toThrow();
  });
});

describe('CREATE temporal de los roles SECURITY DEFINER (modo external)', () => {
  it('crea los tres roles NOLOGIN si faltan y les da CREATE en public', () => {
    const sql = definerRolesGrantStatement();
    for (const role of DEFINER_ROLES) {
      expect(sql).toContain(`rolname = '${role}'`);
      expect(sql).toContain(`CREATE ROLE ${role} NOLOGIN;`);
    }
    expect(sql).toContain(
      'GRANT CREATE ON SCHEMA public TO helpdesk_slug_resolver, helpdesk_outbox_publisher, helpdesk_sla_sweeper',
    );
    // Ni LOGIN ni atributos de más: los mismos roles que crea la migración.
    expect(sql).not.toMatch(/BYPASSRLS|SUPERUSER| LOGIN/);
  });

  it('el revoke retira exactamente ese privilegio a los mismos roles', () => {
    expect(definerRolesRevokeStatement()).toBe(
      'REVOKE CREATE ON SCHEMA public FROM helpdesk_slug_resolver, helpdesk_outbox_publisher, helpdesk_sla_sweeper',
    );
  });
});

describe('findSecurityProblems', () => {
  const appRole = { name: 'helpdesk_app', superuser: false, bypassRls: false };
  const table = (over: Partial<TableRow> = {}): TableRow => ({
    name: 'tickets',
    rls: true,
    forceRls: true,
    owner: 'helpdesk',
    ...over,
  });

  it('no encuentra nada en una base bien migrada', () => {
    expect(findSecurityProblems(appRole, [table()])).toEqual([]);
  });

  it('detecta BYPASSRLS y SUPERUSER en el rol de la app', () => {
    const problems = findSecurityProblems(
      { ...appRole, superuser: true, bypassRls: true },
      [table()],
    );
    expect(problems).toEqual([
      'helpdesk_app es SUPERUSER',
      'helpdesk_app tiene BYPASSRLS',
    ]);
  });

  it('detecta una tabla sin RLS, sin FORCE o propiedad de la app', () => {
    const problems = findSecurityProblems(appRole, [
      table({ name: 'a', rls: false }),
      table({ name: 'b', forceRls: false }),
      table({ name: 'c', owner: 'helpdesk_app' }),
    ]);
    expect(problems).toEqual([
      'a: RLS deshabilitado',
      'b: sin FORCE RLS',
      'c: su dueño es helpdesk_app',
    ]);
  });

  it('detecta un rol que conservó CREATE en public tras migrar', () => {
    expect(
      findSecurityProblems(
        appRole,
        [table()],
        [
          { name: 'helpdesk_app', canCreate: false },
          { name: 'helpdesk_sla_sweeper', canCreate: true },
        ],
      ),
    ).toEqual([
      'helpdesk_sla_sweeper puede crear objetos en el esquema public',
    ]);
  });

  it('falla cerrado si no hay rol de app ni tablas', () => {
    expect(findSecurityProblems(undefined, [])).toHaveLength(2);
  });
});

describe('connectionFor', () => {
  const env = {
    DATABASE_SUPERUSER_URL: 'postgresql://postgres@x/db',
    MIGRATION_DATABASE_URL: 'postgresql://helpdesk@x/db',
  };

  it('modo create: owner y app con el superusuario, verify con el dueño', () => {
    expect(connectionFor('owner', 'create', env)).toBe(
      env.DATABASE_SUPERUSER_URL,
    );
    expect(connectionFor('app', 'create', env)).toBe(
      env.DATABASE_SUPERUSER_URL,
    );
    expect(connectionFor('verify', 'create', env)).toBe(
      env.MIGRATION_DATABASE_URL,
    );
  });

  it('modo external: todo con el dueño, sin pedir superusuario', () => {
    const sinSuperusuario = {
      MIGRATION_DATABASE_URL: env.MIGRATION_DATABASE_URL,
    };
    for (const step of ['owner', 'app', 'verify'] as const) {
      expect(connectionFor(step, 'external', sinSuperusuario)).toBe(
        env.MIGRATION_DATABASE_URL,
      );
    }
  });

  it('dice qué variable falta', () => {
    expect(() => connectionFor('owner', 'create', {})).toThrow(
      /DATABASE_SUPERUSER_URL/,
    );
    expect(() => connectionFor('app', 'external', {})).toThrow(
      /MIGRATION_DATABASE_URL/,
    );
  });
});
