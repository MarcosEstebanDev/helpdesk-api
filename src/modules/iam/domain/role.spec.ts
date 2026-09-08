import { ROLES, Role, hasAtLeastRole, isRole } from './role';

describe('Role', () => {
  describe('isRole', () => {
    it('acepta los roles conocidos', () => {
      for (const role of ROLES) {
        expect(isRole(role)).toBe(true);
      }
    });

    it('rechaza cualquier otra cadena', () => {
      expect(isRole('SUPERADMIN')).toBe(false);
      expect(isRole('admin')).toBe(false); // sensible a mayúsculas
      expect(isRole('')).toBe(false);
    });
  });

  describe('hasAtLeastRole', () => {
    it('todo rol se satisface a sí mismo', () => {
      for (const role of ROLES) {
        expect(hasAtLeastRole(role, role)).toBe(true);
      }
    });

    it('un rol superior satisface el requisito de uno inferior', () => {
      expect(hasAtLeastRole('ADMIN', 'AGENT')).toBe(true);
      expect(hasAtLeastRole('ADMIN', 'VIEWER')).toBe(true);
      expect(hasAtLeastRole('AGENT', 'VIEWER')).toBe(true);
    });

    it('un rol inferior NO satisface el requisito de uno superior', () => {
      expect(hasAtLeastRole('VIEWER', 'AGENT')).toBe(false);
      expect(hasAtLeastRole('VIEWER', 'ADMIN')).toBe(false);
      expect(hasAtLeastRole('AGENT', 'ADMIN')).toBe(false);
    });

    it('la jerarquía es un orden total y transitivo', () => {
      // Si se añadiera un rol que no encaja en el orden, este test lo delata:
      // sería la señal de que toca migrar a permisos granulares (ADR-0014).
      const ordered: Role[] = ['VIEWER', 'AGENT', 'ADMIN'];

      for (let i = 0; i < ordered.length; i++) {
        for (let j = 0; j < ordered.length; j++) {
          expect(hasAtLeastRole(ordered[i], ordered[j])).toBe(i >= j);
        }
      }
    });
  });
});
