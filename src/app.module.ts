import { Module } from '@nestjs/common';
import { ConfigModule } from './infrastructure/config/config.module';
import { PrismaModule } from './infrastructure/prisma/prisma.module';
import { TenantModule } from './infrastructure/tenant/tenant.module';
import { HealthModule } from './modules/health/health.module';
import { IamModule } from './modules/iam/iam.module';

/**
 * Composition root. Each bounded context lives under `src/modules/*` and is
 * wired here. Cross-cutting infrastructure (config, Prisma, tenant context, and
 * later logging and queues) lives under `src/infrastructure/*`.
 */
@Module({
  imports: [ConfigModule, PrismaModule, TenantModule, HealthModule, IamModule],
})
export class AppModule {}
