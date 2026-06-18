import { Module } from '@nestjs/common';
import { ConfigModule } from './infrastructure/config/config.module';
import { HealthModule } from './modules/health/health.module';

/**
 * Composition root. Each bounded context lives under `src/modules/*` and is
 * wired here. Cross-cutting infrastructure (config, and later Prisma, logging,
 * queues) lives under `src/infrastructure/*`.
 */
@Module({
  imports: [ConfigModule, HealthModule],
})
export class AppModule {}
