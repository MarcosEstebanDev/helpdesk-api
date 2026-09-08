/**
 * Rol dentro de una organización. Es POR membership (por tenant), nunca global.
 * Definido en el dominio (no se importa el enum de Prisma): el adapter mapea
 * este tipo al enum de la DB. La autorización por rol llega en Fase 3 (RBAC).
 */
export const ROLES = ['ADMIN', 'AGENT', 'VIEWER'] as const;

export type Role = (typeof ROLES)[number];

export const isRole = (value: string): value is Role =>
  (ROLES as readonly string[]).includes(value);

/**
 * Orden de autoridad (ADR-0014). Es una regla de NEGOCIO —"un ADMIN puede todo
 * lo que puede un AGENT"— y por eso vive en el dominio, no en un guard de HTTP.
 *
 * Números y no un array ordenado: comparar rangos es la operación que se hace
 * en cada request, y así es una comparación de enteros.
 */
const ROLE_RANK: Record<Role, number> = {
  VIEWER: 0,
  AGENT: 1,
  ADMIN: 2,
};

/**
 * ¿`actual` satisface el rango mínimo `required`?
 *
 * Nótese que la pregunta es "al menos", no "igual a": esa es toda la decisión
 * del ADR-0014 condensada en una función.
 */
export const hasAtLeastRole = (actual: Role, required: Role): boolean =>
  ROLE_RANK[actual] >= ROLE_RANK[required];
