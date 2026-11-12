import { isResponder } from './sla/responder-role';

/**
 * A quién está dirigido un comentario (ADR-0028).
 *
 * - `PUBLIC`: la conversación con el cliente. Es lo que había siempre.
 * - `INTERNAL`: una nota del equipo. El cliente (VIEWER) no la ve ni la puede
 *   escribir, y no cuenta como respuesta para el SLA.
 */
export const COMMENT_VISIBILITIES = ['PUBLIC', 'INTERNAL'] as const;

export type CommentVisibility = (typeof COMMENT_VISIBILITIES)[number];

export const isCommentVisibility = (
  value: unknown,
): value is CommentVisibility =>
  typeof value === 'string' &&
  (COMMENT_VISIBILITIES as readonly string[]).includes(value);

/**
 * ¿Este rol forma parte del equipo que atiende? Es la misma pregunta que se hace
 * el SLA ("¿responde en nombre de la organización?"), y tiene que serlo: si un
 * rol pudiera leer notas internas pero su comentario no contara como respuesta,
 * o al revés, las dos reglas acabarían contradiciéndose.
 */
export const isStaff = (role: string): boolean => isResponder(role);

/** Qué comentarios puede ver un rol: el cliente, solo los públicos. */
export const visibleTo = (role: string): readonly CommentVisibility[] =>
  isStaff(role) ? COMMENT_VISIBILITIES : ['PUBLIC'];
