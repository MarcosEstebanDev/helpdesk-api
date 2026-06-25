import { Result, err, ok } from '../../../shared-kernel';
import { MembershipId, TenantId, UserId } from '../domain/ids';
import { slugify } from '../domain/slug';
import {
  IamError,
  InvalidOrganizationNameError,
  OrganizationNameTakenError,
} from '../domain/errors';
import { Email } from '../domain/value-objects/email.vo';
import { Password } from '../domain/value-objects/password.vo';
import { Organization } from '../domain/entities/organization.entity';
import { User } from '../domain/entities/user.entity';
import { Membership } from '../domain/entities/membership.entity';
import { Clock } from '../domain/ports/clock';
import { IdGenerator } from '../domain/ports/id-generator';
import { OrganizationRepository } from '../domain/ports/organization.repository';
import { PasswordHasher } from '../domain/ports/password-hasher';
import { AuthTokens } from './auth-tokens';
import { SessionIssuer } from './session-issuer';

export interface RegisterOrganizationInput {
  organizationName: string;
  email: string;
  password: string;
}

/**
 * Registro self-service (ADR-0011): crea Organization + User + Membership(ADMIN)
 * de forma atómica (provisioning bajo el tenant nuevo) y deja la sesión iniciada.
 */
export class RegisterOrganization {
  constructor(
    private readonly organizations: OrganizationRepository,
    private readonly passwordHasher: PasswordHasher,
    private readonly idGenerator: IdGenerator,
    private readonly clock: Clock,
    private readonly sessionIssuer: SessionIssuer,
  ) {}

  async execute(
    input: RegisterOrganizationInput,
  ): Promise<Result<AuthTokens, IamError>> {
    const emailResult = Email.create(input.email);
    if (emailResult.isErr()) {
      return err(emailResult.error);
    }

    const passwordResult = Password.create(input.password);
    if (passwordResult.isErr()) {
      return err(passwordResult.error);
    }

    const name = input.organizationName.trim();
    const slug = slugify(name);
    if (name.length < 2 || slug.length === 0) {
      return err(new InvalidOrganizationNameError());
    }
    if (await this.organizations.existsBySlug(slug)) {
      return err(new OrganizationNameTakenError(slug));
    }

    const now = this.clock.now();
    const tenantId = TenantId(this.idGenerator.uuid());

    const organization = Organization.create({ id: tenantId, name, slug, now });

    const passwordHash = await this.passwordHasher.hash(passwordResult.value);
    const userId = UserId(this.idGenerator.uuid());
    const owner = User.register({
      id: userId,
      tenantId,
      email: emailResult.value,
      passwordHash,
      now,
    });

    const membership = Membership.create({
      id: MembershipId(this.idGenerator.uuid()),
      tenantId,
      userId,
      role: 'ADMIN',
      now,
    });

    await this.organizations.provision({ organization, owner, membership });

    const tokens = await this.sessionIssuer.issue({
      userId,
      tenantId,
      role: 'ADMIN',
    });
    return ok(tokens);
  }
}
