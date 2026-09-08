import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../infrastructure/prisma/prisma.service';
import { TenantId, UserId } from '../../domain/ids';
import { UserRepository } from '../../domain/ports/user.repository';
import { User } from '../../domain/entities/user.entity';
import { Email } from '../../domain/value-objects/email.vo';
import { toUser } from './iam.mappers';

@Injectable()
export class PrismaUserRepository implements UserRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findByEmail(tenantId: TenantId, email: Email): Promise<User | null> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      // El `tenantId` en el where es redundante con RLS — y esa redundancia es
      // deliberada: si alguien desactivara RLS, la query sigue siendo correcta.
      const row = await tx.user.findUnique({
        where: { tenantId_email: { tenantId, email: email.value } },
      });
      return row === null ? null : toUser(row);
    });
  }

  async findById(tenantId: TenantId, id: UserId): Promise<User | null> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const row = await tx.user.findFirst({ where: { id, tenantId } });
      return row === null ? null : toUser(row);
    });
  }
}
