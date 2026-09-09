import { Clock, IdGenerator } from '../../../shared-kernel';
import {
  MembershipId,
  RefreshFamilyId,
  RefreshTokenId,
  TenantId,
  UserId,
} from '../domain/ids';
import { Membership } from '../domain/entities/membership.entity';
import { RefreshToken } from '../domain/entities/refresh-token.entity';
import { MembershipRepository } from '../domain/ports/membership.repository';
import { RefreshTokenRepository } from '../domain/ports/refresh-token.repository';
import { TokenService } from '../domain/ports/token.service';
import { RefreshTokens } from './refresh-tokens.use-case';
import { SessionIssuer } from './session-issuer';

const TENANT = TenantId('tenant-1');
const USER = UserId('user-1');
const FAMILY = RefreshFamilyId('fam-1');
const NOW = new Date('2026-01-02T00:00:00Z');

const activeStored = (): RefreshToken =>
  RefreshToken.issue({
    id: RefreshTokenId('rt-old'),
    tenantId: TENANT,
    userId: USER,
    familyId: FAMILY,
    tokenHash: 'lookup-hash',
    expiresAt: new Date('2026-01-09T00:00:00Z'),
    now: new Date('2026-01-01T00:00:00Z'),
  });

const buildSut = (stored: RefreshToken | null) => {
  const tokenService: TokenService = {
    signAccessToken: jest.fn().mockResolvedValue('new-access'),
    issueRefreshToken: jest.fn().mockResolvedValue({
      token: 'new-refresh',
      tokenHash: 'new-hash',
      tokenId: 'rt-new',
      expiresAt: new Date('2026-01-09T00:00:00Z'),
    }),
    verifyRefreshToken: jest.fn().mockResolvedValue({
      userId: 'user-1',
      tenantId: 'tenant-1',
      familyId: 'fam-1',
      tokenId: 'rt-old',
    }),
    hashRefreshToken: jest.fn().mockReturnValue('lookup-hash'),
  };
  const refreshTokens: RefreshTokenRepository = {
    save: jest.fn().mockResolvedValue(undefined),
    findByHash: jest.fn().mockResolvedValue(stored),
    markRotated: jest.fn().mockResolvedValue(undefined),
    revokeFamily: jest.fn().mockResolvedValue(undefined),
  };
  const memberships: MembershipRepository = {
    findByUserId: jest.fn().mockResolvedValue(
      Membership.rehydrate({
        id: MembershipId('m-1'),
        tenantId: TENANT,
        userId: USER,
        role: 'AGENT',
        createdAt: new Date('2026-01-01T00:00:00Z'),
      }),
    ),
  };
  const idGenerator: IdGenerator = { uuid: jest.fn(() => 'unused') };
  const clock: Clock = { now: () => NOW };

  const sessionIssuer = new SessionIssuer(
    tokenService,
    refreshTokens,
    idGenerator,
    clock,
  );
  const sut = new RefreshTokens(
    tokenService,
    refreshTokens,
    memberships,
    clock,
    sessionIssuer,
  );
  return { sut, tokenService, refreshTokens };
};

describe('RefreshTokens', () => {
  it('rota un token activo: lo marca usado y emite uno nuevo en la misma familia', async () => {
    const { sut, refreshTokens } = buildSut(activeStored());

    const result = await sut.execute({ refreshToken: 'presented' });

    expect(result.isOk()).toBe(true);
    expect(refreshTokens.markRotated).toHaveBeenCalledWith(
      TENANT,
      RefreshTokenId('rt-old'),
      NOW,
    );
    // la nueva sesión usa la familia existente
    const issued = (refreshTokens.save as jest.Mock).mock
      .calls[0][0] as RefreshToken;
    expect(issued.familyId).toBe(FAMILY);
    expect(refreshTokens.revokeFamily).not.toHaveBeenCalled();
  });

  it('detecta reuse: ante un token ya rotado, revoca la familia y rechaza', async () => {
    const spent = RefreshToken.rehydrate({
      id: RefreshTokenId('rt-old'),
      tenantId: TENANT,
      userId: USER,
      familyId: FAMILY,
      tokenHash: 'lookup-hash',
      expiresAt: new Date('2026-01-09T00:00:00Z'),
      rotatedAt: new Date('2026-01-01T12:00:00Z'),
      revokedAt: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });
    const { sut, refreshTokens } = buildSut(spent);

    const result = await sut.execute({ refreshToken: 'presented' });

    expect(result.isErr()).toBe(true);
    if (result.isErr())
      expect(result.error.code).toBe('iam.refresh_token_reuse');
    expect(refreshTokens.revokeFamily).toHaveBeenCalledWith(
      TENANT,
      FAMILY,
      NOW,
    );
    expect(refreshTokens.markRotated).not.toHaveBeenCalled();
  });

  it('rechaza si la firma del refresh no verifica', async () => {
    const { sut, tokenService } = buildSut(activeStored());
    (tokenService.verifyRefreshToken as jest.Mock).mockResolvedValue(null);
    const result = await sut.execute({ refreshToken: 'forged' });
    expect(result.isErr()).toBe(true);
    if (result.isErr())
      expect(result.error.code).toBe('iam.refresh_token_invalid');
  });

  it('rechaza si el token no está en el repositorio', async () => {
    const { sut } = buildSut(null);
    const result = await sut.execute({ refreshToken: 'presented' });
    expect(result.isErr()).toBe(true);
    if (result.isErr())
      expect(result.error.code).toBe('iam.refresh_token_invalid');
  });

  it('rechaza un token vigente en firma pero expirado en la DB', async () => {
    const expired = RefreshToken.rehydrate({
      id: RefreshTokenId('rt-old'),
      tenantId: TENANT,
      userId: USER,
      familyId: FAMILY,
      tokenHash: 'lookup-hash',
      expiresAt: new Date('2026-01-01T00:00:00Z'),
      rotatedAt: null,
      revokedAt: null,
      createdAt: new Date('2025-12-25T00:00:00Z'),
    });
    const { sut } = buildSut(expired);
    const result = await sut.execute({ refreshToken: 'presented' });
    expect(result.isErr()).toBe(true);
    if (result.isErr())
      expect(result.error.code).toBe('iam.refresh_token_invalid');
  });
});
