import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Identificador de correlación de la unidad de trabajo en curso (ADR-0024).
 *
 * Es un `AsyncLocalStorage` **aparte** del contexto de tenant, y no un campo más
 * dentro de aquel, por dos motivos:
 *
 * 1. El tenant solo existe en peticiones AUTENTICADAS; el `requestId` tiene que
 *    existir siempre, también en un login fallido o en un 404 — que son
 *    justamente las trazas que uno va a buscar cuando algo va mal.
 * 2. Vive más allá de la petición: el worker que procesa un evento del outbox
 *    restaura el `requestId` de la petición que lo originó, y ahí no hay ninguna
 *    request de la que colgarlo.
 */
export interface RequestContext {
  requestId: string;
  /**
   * Tenant al que pertenece el trabajo, **solo para los logs**.
   *
   * Lo rellenan los workers, que sí saben de qué organización es el evento pero
   * no tienen usuario autenticado. No se reutiliza el contexto de tenant de
   * `infrastructure/tenant` porque aquel significa otra cosa —"hay un usuario
   * autenticado de este tenant"— y de él dependen los guards de autorización.
   */
  tenantId?: string | null;
}

const storage = new AsyncLocalStorage<RequestContext>();

export const runWithRequestId = <T>(
  requestId: string,
  fn: () => T,
  tenantId?: string | null,
): T => storage.run({ requestId, tenantId }, fn);

/** `null` fuera de cualquier unidad de trabajo con correlación. */
export const getRequestId = (): string | null =>
  storage.getStore()?.requestId ?? null;

/** Tenant del trabajo en curso, si lo declaró quien lo abrió (solo logs). */
export const getContextTenantId = (): string | null =>
  storage.getStore()?.tenantId ?? null;

/** Cabecera estándar de facto; se respeta la entrante para no romper la cadena. */
export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * Longitud máxima que se acepta de un `x-request-id` entrante.
 *
 * El valor lo elige el cliente, y acaba en todas las líneas de log de esa
 * petición: sin un tope, cualquiera podría inflar el volumen de logs —y la
 * factura— mandando una cabecera de un megabyte.
 */
export const REQUEST_ID_MAX_LENGTH = 128;

/** Deja el id entrante en algo seguro para meter en un log, o `null`. */
export const sanitizeRequestId = (valor: unknown): string | null => {
  if (typeof valor !== 'string') return null;
  const limpio = valor.trim().slice(0, REQUEST_ID_MAX_LENGTH);
  // Solo caracteres inocuos: un id con saltos de línea permitiría inyectar
  // entradas falsas en un log de texto plano.
  return /^[\w.:-]+$/.test(limpio) ? limpio : null;
};
