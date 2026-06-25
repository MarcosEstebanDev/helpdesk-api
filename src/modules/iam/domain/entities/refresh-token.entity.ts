import { Entity } from '../../../../shared-kernel';
import { RefreshFamilyId, RefreshTokenId, TenantId, UserId } from '../ids';

interface RefreshTokenProps {
  tenantId: TenantId;
  userId: UserId;
  familyId: RefreshFamilyId;
  /** Solo se persiste el HASH del token; el valor en claro vive en el cliente. */
  tokenHash: string;
  expiresAt: Date;
  rotatedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

/**
 * Refresh token persistido. Una "familia" agrupa los tokens encadenados por
 * rotación: si se reusa uno ya rotado/revocado (indicio de robo), se revoca la
 * familia entera. Estado derivado: ver {@link isActive}.
 */
export class RefreshToken extends Entity<RefreshTokenId> {
  private constructor(
    id: RefreshTokenId,
    private readonly props: RefreshTokenProps,
  ) {
    super(id);
  }

  get tenantId(): TenantId {
    return this.props.tenantId;
  }

  get userId(): UserId {
    return this.props.userId;
  }

  get familyId(): RefreshFamilyId {
    return this.props.familyId;
  }

  get tokenHash(): string {
    return this.props.tokenHash;
  }

  get expiresAt(): Date {
    return this.props.expiresAt;
  }

  get rotatedAt(): Date | null {
    return this.props.rotatedAt;
  }

  get revokedAt(): Date | null {
    return this.props.revokedAt;
  }

  get createdAt(): Date {
    return this.props.createdAt;
  }

  isExpired(now: Date): boolean {
    return now.getTime() >= this.props.expiresAt.getTime();
  }

  /** Ya fue rotado o revocado: presentarlo de nuevo es reutilización. */
  isSpent(): boolean {
    return this.props.rotatedAt !== null || this.props.revokedAt !== null;
  }

  isActive(now: Date): boolean {
    return !this.isSpent() && !this.isExpired(now);
  }

  static issue(input: {
    id: RefreshTokenId;
    tenantId: TenantId;
    userId: UserId;
    familyId: RefreshFamilyId;
    tokenHash: string;
    expiresAt: Date;
    now: Date;
  }): RefreshToken {
    return new RefreshToken(input.id, {
      tenantId: input.tenantId,
      userId: input.userId,
      familyId: input.familyId,
      tokenHash: input.tokenHash,
      expiresAt: input.expiresAt,
      rotatedAt: null,
      revokedAt: null,
      createdAt: input.now,
    });
  }

  static rehydrate(input: {
    id: RefreshTokenId;
    tenantId: TenantId;
    userId: UserId;
    familyId: RefreshFamilyId;
    tokenHash: string;
    expiresAt: Date;
    rotatedAt: Date | null;
    revokedAt: Date | null;
    createdAt: Date;
  }): RefreshToken {
    return new RefreshToken(input.id, { ...input });
  }
}
