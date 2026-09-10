import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import {
  REQUEST_ID_HEADER,
  runWithRequestId,
  sanitizeRequestId,
} from './request-context';

/**
 * Abre el contexto de correlación de la petición (ADR-0024).
 *
 * Es un middleware, no un interceptor, por el mismo motivo que el de tenant: un
 * interceptor devuelve un Observable que Nest suscribe fuera del scope de
 * `AsyncLocalStorage`, y el contexto se perdería a mitad de la petición.
 *
 * Se coordina con `pino-http` **sin depender del orden de registro**: quien
 * llegue primero fija `req.id` y el otro lo reutiliza. Si dependiera del orden,
 * un día los logs de acceso y los del dominio traerían ids distintos para la
 * misma petición, que es peor que no tener correlación — porque parece que sí la
 * hay.
 */
export function requestIdMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const yaAsignado = sanitizeRequestId((req as { id?: unknown }).id);
  const entrante = sanitizeRequestId(req.headers[REQUEST_ID_HEADER]);
  const requestId = yaAsignado ?? entrante ?? randomUUID();

  (req as { id?: string }).id = requestId;
  if (!res.headersSent) {
    res.setHeader(REQUEST_ID_HEADER, requestId);
  }

  runWithRequestId(requestId, () => next());
}
