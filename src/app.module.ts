import { Module } from '@nestjs/common';
import { ConfigModule } from './infrastructure/config/config.module';
import { PrismaModule } from './infrastructure/prisma/prisma.module';
import { HealthModule } from './modules/health/health.module';

/**
 * Composition root. Each bounded context lives under `src/modules/*` and is
 * wired here. Cross-cutting infrastructure (config, Prisma, and later logging,
 * queues) lives under `src/infrastructure/*`.
 */
@Module({
  imports: [ConfigModule, PrismaModule, HealthModule],
})
export class AppModule {}
