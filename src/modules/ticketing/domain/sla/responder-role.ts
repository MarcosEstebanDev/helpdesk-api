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
