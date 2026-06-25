import { RefreshFamilyId, RefreshTokenId, TenantId, UserId } from '../ids';
import { RefreshToken } from './refresh-token.entity';

const make = (overrides?: { expiresAt?: Date; now?: Date }): RefreshToken => {
  const now = overrides?.now ?? new Date('2026-01-01T00:00:00Z');
  return RefreshToken.issue({
    id: RefreshTokenId('rt-1'),
    tenantId: TenantId('t-1'),
    userId: UserId('u-1'),
    familyId: RefreshFamilyId('fam-1'),
    tokenHash: 'hash',
    expiresAt: overrides?.expiresAt ?? new Date('2026-01-08T00:00:00Z'),
    now,
  });
};

describe('RefreshToken', () => {
  const now = new Date('2026-01-02T00:00:00Z');

  it('recién emitido está activo', () => {
    const token = make();
    expect(token.isActive(now)).toBe(true);
    expect(token.isSpent()).toBe(false);
  });

  it('está expirado cuando now >= expiresAt', () => {
    const token = make({ expiresAt: new Date('2026-01-02T00:00:00Z') });
    expect(token.isExpired(now)).toBe(true);
    expect(token.isActive(now)).toBe(false);
  });

  it('rehidratado como rotado cuenta como gastado (reuse)', () => {
    const token = RefreshToken.rehydrate({
      id: RefreshTokenId('rt-1'),
      tenantId: TenantId('t-1'),
      userId: UserId('u-1'),
      familyId: RefreshFamilyId('fam-1'),
      tokenHash: 'hash',
      expiresAt: new Date('2026-01-08T00:00:00Z'),
      rotatedAt: new Date('2026-01-01T12:00:00Z'),
      revokedAt: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });
    expect(token.isSpent()).toBe(true);
    expect(token.isActive(now)).toBe(false);
  });
});
