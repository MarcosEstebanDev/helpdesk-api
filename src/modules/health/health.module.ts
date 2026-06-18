import { Module } from '@nestjs/common';
import { HealthController } from './infrastructure/http/health.controller';

@Module({
  controllers: [HealthController],
})
export class HealthModule {}
