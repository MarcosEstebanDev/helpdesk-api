import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../infrastructure/prisma/prisma.service';
import { RefreshFamilyId, RefreshTokenId, TenantId } from '../../domain/ids';
import { RefreshTokenRepository } from '../../domain/ports/refresh-token.repository';
import { RefreshToken } from '../../domain/entities/refresh-token.entity';
import { toRefreshToken } from './iam.mappers';

@Injectable()
export class PrismaRefreshTokenRepository implements RefreshTokenRepository {
  constructor(private readonly prisma: PrismaService) {}

  async save(token: RefreshToken): Promise<void> {
    await this.prisma.withTenant(token.tenantId, async (tx) => {
      await tx.refreshToken.create({
        data: {
          id: token.id,
          tenantId: token.tenantId,
          userId: token.userId,
          familyId: token.familyId,
          tokenHash: token.tokenHash,
          expiresAt: token.expiresAt,
          createdAt: token.createdAt,
        },
      });
    });
  }

  async findByHash(
    tenantId: TenantId,
    tokenHash: string,
  ): Promise<RefreshToken | null> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      // `tokenHash` es único global, pero RLS acota igualmente al tenant: un hash
      // de otra organización devuelve null aunque exista la fila.
      const row = await tx.refreshToken.findFirst({
        where: { tokenHash, tenantId },
      });
      return row === null ? null : toRefreshToken(row);
    });
  }

  /**
   * `updateMany` con `rotatedAt: null` en el where, no `update` por id: si dos
   * requests concurrentes presentan el mismo refresh, solo una marca la rotación.
   * La otra no encuentra fila que actualizar y su lectura posterior verá el token
   * ya gastado, que es exactamente la señal de reuse que queremos.
   */
  async markRotated(
    tenantId: TenantId,
    id: RefreshTokenId,
    rotatedAt: Date,
  ): Promise<void> {
    await this.prisma.withTenant(tenantId, async (tx) => {
      await tx.refreshToken.updateMany({
        where: { id, tenantId, rotatedAt: null },
        data: { rotatedAt },
      });
    });
  }

  async revokeFamily(
    tenantId: TenantId,
    familyId: RefreshFamilyId,
    revokedAt: Date,
  ): Promise<void> {
    await this.prisma.withTenant(tenantId, async (tx) => {
      await tx.refreshToken.updateMany({
        where: { familyId, tenantId, revokedAt: null },
        data: { revokedAt },
      });
    });
  }
}
