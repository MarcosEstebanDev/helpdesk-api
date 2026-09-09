import { Clock } from '../../../shared-kernel';
import {
  RefreshFamilyId,
  RefreshTokenId,
  TenantId,
  UserId,
} from '../domain/ids';
import { RefreshToken } from '../domain/entities/refresh-token.entity';
import { RefreshTokenRepository } from '../domain/ports/refresh-token.repository';
import { TokenService } from '../domain/ports/token.service';
import { Logout } from './logout.use-case';

const TENANT = TenantId('tenant-1');
const FAMILY = RefreshFamilyId('fam-1');
const NOW = new Date('2026-01-02T00:00:00Z');

const buildSut = (stored: RefreshToken | null, verifies = true) => {
  const tokenService: TokenService = {
    signAccessToken: jest.fn(),
    issueRefreshToken: jest.fn(),
    verifyRefreshToken: jest.fn().mockResolvedValue(
      verifies
        ? {
            userId: 'user-1',
            tenantId: 'tenant-1',
            familyId: 'fam-1',
            tokenId: 'rt-1',
          }
        : null,
    ),
    hashRefreshToken: jest.fn().mockReturnValue('lookup-hash'),
  };
  const refreshTokens: RefreshTokenRepository = {
    save: jest.fn(),
    findByHash: jest.fn().mockResolvedValue(stored),
    markRotated: jest.fn(),
    revokeFamily: jest.fn().mockResolvedValue(undefined),
  };
  const clock: Clock = { now: () => NOW };
  const sut = new Logout(tokenService, refreshTokens, clock);
  return { sut, refreshTokens };
};

const storedToken = (): RefreshToken =>
  RefreshToken.issue({
    id: RefreshTokenId('rt-1'),
    tenantId: TENANT,
    userId: UserId('user-1'),
    familyId: FAMILY,
    tokenHash: 'lookup-hash',
    expiresAt: new Date('2026-01-09T00:00:00Z'),
    now: new Date('2026-01-01T00:00:00Z'),
  });

describe('Logout', () => {
  it('revoca la familia del refresh token presentado', async () => {
    const { sut, refreshTokens } = buildSut(storedToken());
    const result = await sut.execute({ refreshToken: 'presented' });
    expect(result.isOk()).toBe(true);
    expect(refreshTokens.revokeFamily).toHaveBeenCalledWith(
      TENANT,
      FAMILY,
      NOW,
    );
  });

  it('es idempotente: token inválido no es error', async () => {
    const { sut, refreshTokens } = buildSut(null, false);
    const result = await sut.execute({ refreshToken: 'garbage' });
    expect(result.isOk()).toBe(true);
    expect(refreshTokens.revokeFamily).not.toHaveBeenCalled();
  });
});
