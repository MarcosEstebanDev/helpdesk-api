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

  /**
   * Miembros que pueden ATENDER tickets, en orden estable.
   *
   * Incluye ADMIN además de AGENT: por la jerarquía del ADR-0014 un ADMIN puede
   * todo lo que puede un AGENT, y en una organización pequeña suele ser quien
   * atiende. Excluye a VIEWER, que es el usuario final.
   *
   * El ORDEN debe ser estable (por id): el reparto automático lo usa para
   * repartir de forma determinista, y un orden que cambie entre llamadas haría
   * que reprocesar el mismo evento diera un resultado distinto.
   */
  agentsOf(tenantId: TenantId): Promise<UserId[]>;
}

export const MEMBER_DIRECTORY = Symbol('ticketing.MemberDirectory');
