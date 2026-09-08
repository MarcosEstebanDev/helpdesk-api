import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../infrastructure/prisma/prisma.service';
import { TenantId, UserId } from '../../domain/ids';
import { MembershipRepository } from '../../domain/ports/membership.repository';
import { Membership } from '../../domain/entities/membership.entity';
import { toMembership } from './iam.mappers';

@Injectable()
export class PrismaMembershipRepository implements MembershipRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findByUserId(
    tenantId: TenantId,
    userId: UserId,
  ): Promise<Membership | null> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const row = await tx.membership.findUnique({
        where: { tenantId_userId: { tenantId, userId } },
      });
      return row === null ? null : toMembership(row);
    });
  }
}
