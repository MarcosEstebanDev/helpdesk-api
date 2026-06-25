/**
 * Rol dentro de una organización. Es POR membership (por tenant), nunca global.
 * Definido en el dominio (no se importa el enum de Prisma): el adapter mapea
 * este tipo al enum de la DB. La autorización por rol llega en Fase 3 (RBAC).
 */
export const ROLES = ['ADMIN', 'AGENT', 'VIEWER'] as const;

export type Role = (typeof ROLES)[number];

export const isRole = (value: string): value is Role =>
  (ROLES as readonly string[]).includes(value);
