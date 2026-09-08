import { AsyncLocalStorage } from 'node:async_hooks';

export interface TenantContext {
  tenantId: string;
  userId: string;
  role: string;
}

/**
 * Contexto de tenant de la request en curso (ADR-0003).
 *
 * Usa `AsyncLocalStorage` en vez de pasar el `tenantId` por parámetro en cada
 * capa: el dominio no debería enterarse de que existe una request HTTP. Los
 * repos lo leen para saber bajo qué tenant abrir `withTenant`.
 *
 * IMPORTANTE: el valor entra SIEMPRE desde el JWT verificado, nunca del body,
 * params o query.
 */
const storage = new AsyncLocalStorage<TenantContext>();

export const runWithTenantContext = <T>(
  context: TenantContext,
  fn: () => T,
): T => storage.run(context, fn);

/** Devuelve el contexto actual, o `null` fuera de una request autenticada. */
export const getTenantContext = (): TenantContext | null =>
  storage.getStore() ?? null;

/** Igual que {@link getTenantContext} pero exige que exista (uso interno). */
export const requireTenantContext = (): TenantContext => {
  const context = storage.getStore();
  if (context === undefined) {
    throw new Error(
      'No hay contexto de tenant: ¿falta el JwtAuthGuard en esta ruta?',
    );
  }
  return context;
};
