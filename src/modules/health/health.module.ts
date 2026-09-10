import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { HealthController } from './infrastructure/http/health.controller';
import { RedisHealthIndicator } from './infrastructure/http/redis.health';

/**
 * Sondas de salud (ADR-0024). `TerminusModule` aporta el orquestador de checks;
 * los indicadores concretos se declaran aquí porque dependen de la
 * infraestructura que usa de verdad la aplicación (Prisma y la cola de BullMQ),
 * no de clientes propios.
 */
@Module({
  imports: [TerminusModule],
  controllers: [HealthController],
  providers: [RedisHealthIndicator],
})
export class HealthModule {}
