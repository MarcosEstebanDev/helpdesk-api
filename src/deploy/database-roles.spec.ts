import {
  appRoleStatement,
  assertSafePassword,
  ownerRoleStatement,
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
