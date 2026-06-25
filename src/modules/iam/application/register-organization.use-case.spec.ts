import { RefreshToken } from '../domain/entities/refresh-token.entity';
import { PasswordHash } from '../domain/value-objects/password-hash.vo';
import { Clock } from '../domain/ports/clock';
import { IdGenerator } from '../domain/ports/id-generator';
import { OrganizationRepository } from '../domain/ports/organization.repository';
import { PasswordHasher } from '../domain/ports/password-hasher';
import { RefreshTokenRepository } from '../domain/ports/refresh-token.repository';
import { TokenService } from '../domain/ports/token.service';
import { RegisterOrganization } from './register-organization.use-case';
import { SessionIssuer } from './session-issuer';

const buildSut = () => {
  const saved: RefreshToken[] = [];
  let seq = 0;

  const organizations: OrganizationRepository = {
    existsBySlug: jest.fn().mockResolvedValue(false),
    findIdBySlug: jest.fn(),
    provision: jest.fn().mockResolvedValue(undefined),
  };
  const passwordHasher: PasswordHasher = {
    hash: jest.fn().mockResolvedValue(PasswordHash.fromHash('argon2-hash')),
    verify: jest.fn(),
  };
  const idGenerator: IdGenerator = { uuid: jest.fn(() => `id-${++seq}`) };
  const clock: Clock = { now: () => new Date('2026-01-01T00:00:00Z') };
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
    save: jest.fn((t: RefreshToken): Promise<void> => {
      saved.push(t);
      return Promise.resolve();
    }),
    findByHash: jest.fn(),
    markRotated: jest.fn(),
    revokeFamily: jest.fn(),
  };

  const sessionIssuer = new SessionIssuer(
    tokenService,
    refreshTokens,
    idGenerator,
    clock,
  );
  const sut = new RegisterOrganization(
    organizations,
    passwordHasher,
    idGenerator,
    clock,
    sessionIssuer,
  );
  return { sut, organizations, passwordHasher, saved };
};

describe('RegisterOrganization', () => {
  const validInput = {
    organizationName: 'Acme Inc',
    email: 'admin@acme.com',
    password: 'super-secreta',
  };

  it('crea org + owner + membership ADMIN y deja la sesión iniciada', async () => {
    const { sut, organizations, saved } = buildSut();

    const result = await sut.execute(validInput);

    expect(result.isOk()).toBe(true);
    const provision = (organizations.provision as jest.Mock).mock.calls[0][0];
    expect(provision.organization.slug).toBe('acme-inc');
    expect(provision.organization.name).toBe('Acme Inc');
    expect(provision.membership.role).toBe('ADMIN');
    // owner y membership apuntan al mismo tenant y usuario
    expect(provision.owner.tenantId).toBe(provision.organization.id);
    expect(provision.membership.userId).toBe(provision.owner.id);
    // se persistió un refresh token de la nueva sesión
    expect(saved).toHaveLength(1);
    if (result.isOk()) {
      expect(result.value.accessToken).toBe('access-jwt');
      expect(result.value.refreshToken).toBe('refresh-jwt');
    }
  });

  it('hashea el password (nunca lo guarda en claro)', async () => {
    const { sut, passwordHasher } = buildSut();
    await sut.execute(validInput);
    expect(passwordHasher.hash).toHaveBeenCalledTimes(1);
  });

  it('rechaza email inválido', async () => {
    const { sut } = buildSut();
    const result = await sut.execute({ ...validInput, email: 'no-arroba' });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.code).toBe('iam.invalid_email');
  });

  it('rechaza password débil', async () => {
    const { sut } = buildSut();
    const result = await sut.execute({ ...validInput, password: 'corta' });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.code).toBe('iam.weak_password');
  });

  it('rechaza si el slug ya existe', async () => {
    const { sut, organizations } = buildSut();
    (organizations.existsBySlug as jest.Mock).mockResolvedValue(true);
    const result = await sut.execute(validInput);
    expect(result.isErr()).toBe(true);
    if (result.isErr())
      expect(result.error.code).toBe('iam.organization_name_taken');
  });
});
