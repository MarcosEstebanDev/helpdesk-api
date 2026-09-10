import { randomUUID } from 'node:crypto';
import { runWithRequestId, sanitizeRequestId } from './request-context';

/**
 * Restaura la correlación de un job de cola (ADR-0024).
 *
 * Sin esto, la petición HTTP y sus efectos asíncronos —la auto-asignación, los
 * relojes de SLA, el aviso por WebSocket— quedan como dos historias sin relación
 * separadas por unos milisegundos. Con esto, buscar un `requestId` en los logs
 * devuelve la petición **y** todo lo que provocó, aunque haya ocurrido en otro
 * proceso y medio minuto después.
 *
 * Si el evento no traía correlación (nació de un barrido, o se escribió antes de
 * esta fase) se genera una nueva en vez de dejarlo sin nada: el trabajo del job
 * sigue mereciendo poder seguirse de principio a fin, aunque no se pueda enlazar
 * hacia atrás.
 */
export const runWithJobContext = <T>(
  requestId: string | null | undefined,
  tenantId: string,
  fn: () => T,
): T =>
  runWithRequestId(sanitizeRequestId(requestId) ?? randomUUID(), fn, tenantId);
