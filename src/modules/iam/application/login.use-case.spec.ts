import { Clock, IdGenerator } from '../../../shared-kernel';
import { MembershipId, TenantId, UserId } from '../domain/ids';
import { User } from '../domain/entities/user.entity';
import { Membership } from '../domain/entities/membership.entity';
import { Email } from '../domain/value-objects/email.vo';
import { PasswordHash } from '../domain/value-objects/password-hash.vo';
import { MembershipRepository } from '../domain/ports/membership.repository';
import { OrganizationRepository } from '../domain/ports/organization.repository';
import { PasswordHasher } from '../domain/ports/password-hasher';
import { RefreshTokenRepository } from '../domain/ports/refresh-token.repository';
import { TokenService } from '../domain/ports/token.service';
import { Login } from './login.use-case';
import { SessionIssuer } from './session-issuer';

const emailVo = (raw: string): Email => {
  const r = Email.create(raw);
  if (r.isErr()) throw new Error('email de test inválido');
  return r.value;
};

const buildSut = () => {
  const tenantId = TenantId('tenant-1');
  const userId = UserId('user-1');
  const user = User.rehydrate({
    id: userId,
    tenantId,
    email: emailVo('admin@acme.com'),
    passwordHash: PasswordHash.fromHash('stored-hash'),
    createdAt: new Date('2026-01-01T00:00:00Z'),
  });
  const membership = Membership.rehydrate({
    id: MembershipId('m-1'),
    tenantId,
    userId,
    role: 'ADMIN',
    createdAt: new Date('2026-01-01T00:00:00Z'),
  });

  const organizations: OrganizationRepository = {
    existsBySlug: jest.fn(),
    findIdBySlug: jest.fn().mockResolvedValue(tenantId),
    provision: jest.fn(),
  };
  const users = {
    findByEmail: jest.fn().mockResolvedValue(user),
    findById: jest.fn(),
  };
  const memberships: MembershipRepository = {
    findByUserId: jest.fn().mockResolvedValue(membership),
  };
  const passwordHasher: PasswordHasher = {
    hash: jest.fn(),
    verify: jest.fn(
      (plain: string): Promise<boolean> =>
        Promise.resolve(plain === 'correct-password'),
    ),
  };
  const tokenService: TokenService = {
    signAccessToken: jest.fn().mockResolvedValue('access-jwt'),
    issueRefreshToken: jest.fn().mockResolvedValue({
      token: 'refresh-jwt',
      tokenHash: 'refresh-hash',
      tokenId: 'rt-1',
      expiresAt: new Date('2026-01-08T00:00:00Z'),
    }),
    verifyRefreshToken: jest.fn(),
    hashRefreshToken: jest.fn(),
  };
  const refreshTokens: RefreshTokenRepository = {
    save: jest.fn().mockResolvedValue(undefined),
    findByHash: jest.fn(),
    markRotated: jest.fn(),
    revokeFamily: jest.fn(),
  };
  const idGenerator: IdGenerator = { uuid: jest.fn(() => 'fam-1') };
  const clock: Clock = { now: () => new Date('2026-01-01T00:00:00Z') };

  const sessionIssuer = new SessionIssuer(
    tokenService,
    refreshTokens,
    idGenerator,
    clock,
  );
  const sut = new Login(
    organizations,
    users,
    memberships,
    passwordHasher,
    sessionIssuer,
  );
  return { sut, organizations, users, memberships };
};

describe('Login', () => {
  const input = {
    organizationSlug: 'acme-inc',
    email: 'admin@acme.com',
    password: 'correct-password',
  };

  it('emite tokens con credenciales correctas', async () => {
    const { sut } = buildSut();
    const result = await sut.execute(input);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.accessToken).toBe('access-jwt');
      expect(result.value.refreshToken).toBe('refresh-jwt');
    }
  });

  it('falla genérico si el slug no resuelve a un tenant', async () => {
    const { sut, organizations } = buildSut();
    (organizations.findIdBySlug as jest.Mock).mockResolvedValue(null);
    const result = await sut.execute(input);
    expect(result.isErr()).toBe(true);
    if (result.isErr())
      expect(result.error.code).toBe('iam.invalid_credentials');
  });

  it('falla genérico si el password no coincide', async () => {
    const { sut } = buildSut();
    const result = await sut.execute({ ...input, password: 'wrong' });
    expect(result.isErr()).toBe(true);
    if (result.isErr())
      expect(result.error.code).toBe('iam.invalid_credentials');
  });

  it('falla si el usuario no tiene membership en el tenant', async () => {
    const { sut, memberships } = buildSut();
    (memberships.findByUserId as jest.Mock).mockResolvedValue(null);
    const result = await sut.execute(input);
    expect(result.isErr()).toBe(true);
    if (result.isErr())
      expect(result.error.code).toBe('iam.invalid_credentials');
  });
});
