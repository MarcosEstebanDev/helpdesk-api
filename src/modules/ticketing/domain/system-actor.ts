import { UserId } from './ids';

/**
 * Actor con el que se auditan las acciones automáticas (ADR-0019).
 *
 * El `AuditLog` exige saber QUIÉN hizo cada cosa, pero un job de la cola no lo
 * hace ninguna persona. En vez de permitir un actor nulo —que obligaría a tratar
 * el caso en cada lectura del historial— se usa un UUID reservado y explícito:
 * el historial sigue siendo uniforme y "lo hizo el sistema" se lee igual de bien.
 *
 * Es posible porque `audit_logs.actor_id` NO tiene clave foránea a `users`
 * (decisión de la fase 4: la auditoría debe sobrevivir al borrado de lo que
 * audita). Aquí esa misma propiedad permite un actor que no es un usuario.
 */
export const SYSTEM_ACTOR_ID = UserId('00000000-0000-0000-0000-000000000000');
