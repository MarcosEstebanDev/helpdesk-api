import type { CommentVisibility } from '../comment-visibility';

/**
 * ¿Este rol responde EN NOMBRE de la organización?
 *
 * El SLA de primera respuesta mide cuánto tarda la organización en contestarle
 * al cliente, así que un comentario del propio solicitante (VIEWER) no para el
 * reloj — si lo parara, bastaría con que el cliente insistiera para "cumplir".
 *
 * La jerarquía completa de roles vive en `iam` (ADR-0014); aquí solo se necesita
 * esta pregunta concreta, y declararla es más barato que acoplar los dos
 * bounded contexts para reutilizar `hasAtLeastRole`.
 */
const RESPONDER_ROLES: readonly string[] = ['AGENT', 'ADMIN'];

export const isResponder = (role: string): boolean =>
  RESPONDER_ROLES.includes(role);

/**
 * ¿Este comentario es la respuesta que espera el SLA de primera respuesta?
 *
 * Tiene que escribirlo el equipo Y tiene que verlo el cliente (ADR-0028). Una
 * nota interna ("lo miro mañana") no le contesta nada a nadie: si parara el
 * reloj, el SLA se cumpliría sin que el cliente recibiera una sola palabra.
 */
export const countsAsResponse = (comment: {
  authorRole: string;
  visibility: CommentVisibility;
}): boolean =>
  isResponder(comment.authorRole) && comment.visibility === 'PUBLIC';
