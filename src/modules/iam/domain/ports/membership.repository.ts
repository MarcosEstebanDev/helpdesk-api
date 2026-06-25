import { TenantId, UserId } from '../ids';
import { Membership } from '../entities/membership.entity';

/**
 * Puerto de lectura de memberships. El rol que va en el access token sale de acá
 * (no del User), y se re-lee en cada refresh para reflejar cambios/revocaciones.
 */
export interface MembershipRepository {
  findByUserId(tenantId: TenantId, userId: UserId): Promise<Membership | null>;
}

export const MEMBERSHIP_REPOSITORY = Symbol('iam.MembershipRepository');
