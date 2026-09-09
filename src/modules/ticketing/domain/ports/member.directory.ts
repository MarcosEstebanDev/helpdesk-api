import { TenantId, UserId } from '../ids';

/**
 * Consulta de pertenencia a la organización.
 *
 * Ticketing necesita saber si el usuario al que se asigna un ticket existe en
 * este tenant, pero no debe importar los repositorios de `iam`: eso ataría dos
 * bounded contexts. En su lugar declara el mínimo que necesita —una pregunta de
 * sí o no— y `iam` la satisface a través de un adapter en la infraestructura.
 *
 * RLS hace además que la respuesta sea segura por construcción: la consulta va
 * acotada al tenant, así que jamás puede confirmar la existencia de un usuario
 * de otra organización.
 */
export interface MemberDirectory {
  isMember(tenantId: TenantId, userId: UserId): Promise<boolean>;
}

export const MEMBER_DIRECTORY = Symbol('ticketing.MemberDirectory');
