import { AggregateRoot } from '../../../../shared-kernel';
import { TenantId, UserId } from '../ids';
import { Email } from '../value-objects/email.vo';
import { PasswordHash } from '../value-objects/password-hash.vo';

interface UserProps {
  tenantId: TenantId;
  email: Email;
  passwordHash: PasswordHash;
  createdAt: Date;
}

/**
 * Usuario perteneciente a un tenant. El email es único POR tenant.
 */
export class User extends AggregateRoot<UserId> {
  private constructor(
    id: UserId,
    private readonly props: UserProps,
  ) {
    super(id);
  }

  get tenantId(): TenantId {
    return this.props.tenantId;
  }

  get email(): Email {
    return this.props.email;
  }

  get passwordHash(): PasswordHash {
    return this.props.passwordHash;
  }

  get createdAt(): Date {
    return this.props.createdAt;
  }

  static register(input: {
    id: UserId;
    tenantId: TenantId;
    email: Email;
    passwordHash: PasswordHash;
    now: Date;
  }): User {
    return new User(input.id, {
      tenantId: input.tenantId,
      email: input.email,
      passwordHash: input.passwordHash,
      createdAt: input.now,
    });
  }

  static rehydrate(input: {
    id: UserId;
    tenantId: TenantId;
    email: Email;
    passwordHash: PasswordHash;
    createdAt: Date;
  }): User {
    return new User(input.id, {
      tenantId: input.tenantId,
      email: input.email,
      passwordHash: input.passwordHash,
      createdAt: input.createdAt,
    });
  }
}
