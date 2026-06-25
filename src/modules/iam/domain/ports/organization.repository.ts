import { TenantId } from '../ids';
import { Organization } from '../entities/organization.entity';
import { User } from '../entities/user.entity';
import { Membership } from '../entities/membership.entity';

export interface ProvisionOrganizationInput {
  organization: Organization;
  owner: User;
  membership: Membership;
}

/**
 * Puerto de persistencia de organizaciones.
 *
 * `provision` resuelve el huevo-o-la-gallina del tenant (ADR-0010/0011): como la
 * organización todavía no existe, el adapter abre `withTenant(organization.id)` y
 * crea org + owner + membership en UNA transacción (el WITH CHECK de RLS pasa
 * porque el contexto coincide con el tenant nuevo).
 *
 * `findIdBySlug`/`existsBySlug` resuelven el tenant en el login a partir del slug;
 * el adapter los implementa con un camino que no depende del contexto de tenant
 * (función `SECURITY DEFINER`), ya que el slug se consulta ANTES de conocer el tenant.
 */
export interface OrganizationRepository {
  existsBySlug(slug: string): Promise<boolean>;
  findIdBySlug(slug: string): Promise<TenantId | null>;
  provision(input: ProvisionOrganizationInput): Promise<void>;
}

export const ORGANIZATION_REPOSITORY = Symbol('iam.OrganizationRepository');
