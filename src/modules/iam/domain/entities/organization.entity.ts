import { AggregateRoot } from '../../../../shared-kernel';
import { TenantId } from '../ids';

interface OrganizationProps {
  name: string;
  slug: string;
  createdAt: Date;
}

/**
 * Tenant raíz. Su id ES el `TenantId` por el que se aísla todo lo demás (RLS).
 */
export class Organization extends AggregateRoot<TenantId> {
  private constructor(
    id: TenantId,
    private readonly props: OrganizationProps,
  ) {
    super(id);
  }

  get name(): string {
    return this.props.name;
  }

  get slug(): string {
    return this.props.slug;
  }

  get createdAt(): Date {
    return this.props.createdAt;
  }

  static create(input: {
    id: TenantId;
    name: string;
    slug: string;
    now: Date;
  }): Organization {
    return new Organization(input.id, {
      name: input.name,
      slug: input.slug,
      createdAt: input.now,
    });
  }

  /** Reconstrucción desde persistencia (usada por los repos en 2c). */
  static rehydrate(input: {
    id: TenantId;
    name: string;
    slug: string;
    createdAt: Date;
  }): Organization {
    return new Organization(input.id, {
      name: input.name,
      slug: input.slug,
      createdAt: input.createdAt,
    });
  }
}
