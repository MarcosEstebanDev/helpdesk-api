import { Entity } from '../../../../shared-kernel';
import { MembershipId, TenantId, UserId } from '../ids';
import { Role } from '../role';

interface MembershipProps {
  tenantId: TenantId;
  userId: UserId;
  role: Role;
  createdAt: Date;
}

/**
 * Relación usuario <-> organización con su rol. El rol vive acá (por tenant),
 * no en el User: el mismo usuario podría tener roles distintos en otra org.
 */
export class Membership extends Entity<MembershipId> {
  private constructor(
    id: MembershipId,
    private readonly props: MembershipProps,
  ) {
    super(id);
  }

  get tenantId(): TenantId {
    return this.props.tenantId;
  }

  get userId(): UserId {
    return this.props.userId;
  }

  get role(): Role {
    return this.props.role;
  }

  get createdAt(): Date {
    return this.props.createdAt;
  }

  static create(input: {
    id: MembershipId;
    tenantId: TenantId;
    userId: UserId;
    role: Role;
    now: Date;
  }): Membership {
    return new Membership(input.id, {
      tenantId: input.tenantId,
      userId: input.userId,
      role: input.role,
      createdAt: input.now,
    });
  }

  static rehydrate(input: {
    id: MembershipId;
    tenantId: TenantId;
    userId: UserId;
    role: Role;
    createdAt: Date;
  }): Membership {
    return new Membership(input.id, {
      tenantId: input.tenantId,
      userId: input.userId,
      role: input.role,
      createdAt: input.createdAt,
    });
  }
}
