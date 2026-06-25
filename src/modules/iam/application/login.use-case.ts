import { Result, err, ok } from '../../../shared-kernel';
import { IamError, InvalidCredentialsError } from '../domain/errors';
import { Email } from '../domain/value-objects/email.vo';
import { MembershipRepository } from '../domain/ports/membership.repository';
import { OrganizationRepository } from '../domain/ports/organization.repository';
import { PasswordHasher } from '../domain/ports/password-hasher';
import { UserRepository } from '../domain/ports/user.repository';
import { AuthTokens } from './auth-tokens';
import { SessionIssuer } from './session-issuer';

export interface LoginInput {
  organizationSlug: string;
  email: string;
  password: string;
}

/**
 * Login multi-tenant: el `organizationSlug` resuelve el tenant ANTES de buscar al
 * usuario (el email es único por tenant). Todos los caminos de fallo devuelven el
 * mismo error genérico para no filtrar si existe la org, el email o el password.
 */
export class Login {
  constructor(
    private readonly organizations: OrganizationRepository,
    private readonly users: UserRepository,
    private readonly memberships: MembershipRepository,
    private readonly passwordHasher: PasswordHasher,
    private readonly sessionIssuer: SessionIssuer,
  ) {}

  async execute(input: LoginInput): Promise<Result<AuthTokens, IamError>> {
    const tenantId = await this.organizations.findIdBySlug(
      input.organizationSlug,
    );
    if (tenantId === null) {
      return err(new InvalidCredentialsError());
    }

    const emailResult = Email.create(input.email);
    if (emailResult.isErr()) {
      return err(new InvalidCredentialsError());
    }

    const user = await this.users.findByEmail(tenantId, emailResult.value);
    if (user === null) {
      return err(new InvalidCredentialsError());
    }

    const passwordOk = await this.passwordHasher.verify(
      input.password,
      user.passwordHash,
    );
    if (!passwordOk) {
      return err(new InvalidCredentialsError());
    }

    const membership = await this.memberships.findByUserId(tenantId, user.id);
    if (membership === null) {
      return err(new InvalidCredentialsError());
    }

    const tokens = await this.sessionIssuer.issue({
      userId: user.id,
      tenantId,
      role: membership.role,
    });
    return ok(tokens);
  }
}
