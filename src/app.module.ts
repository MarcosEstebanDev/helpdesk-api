import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ConfigModule } from './infrastructure/config/config.module';
import { PrismaModule } from './infrastructure/prisma/prisma.module';
import { SystemModule } from './infrastructure/system/system.module';
import { GLOBAL_THROTTLE } from './modules/iam/infrastructure/http/throttle.policy';
import { HealthModule } from './modules/health/health.module';
import { IamModule } from './modules/iam/iam.module';
import { TicketingModule } from './modules/ticketing/ticketing.module';
import { RolesGuard } from './modules/iam/infrastructure/auth/roles.guard';

/**
 * Composition root. Each bounded context lives under `src/modules/*` and is
 * wired here. Cross-cutting infrastructure (config, Prisma, and later logging
 * and queues) lives under `src/infrastructure/*`.
 *
 * El rate limiting se registra como guard GLOBAL (ADR-0013): así ninguna ruta
 * nueva nace sin protección por olvido. Los endpoints sensibles lo endurecen
 * con `@Throttle`, y quien necesite quedar fuera debe pedirlo explícitamente.
 */
@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    SystemModule,
    ThrottlerModule.forRoot({
      throttlers: [{ ttl: GLOBAL_THROTTLE.ttl, limit: GLOBAL_THROTTLE.limit }],
      // Escape hatch SOLO para los tests de flujo, que encadenan varios logins.
      // Exige las DOS condiciones: en producción `NODE_ENV` nunca es 'test', así
      // que ninguna variable de entorno puede desactivar el rate limiting.
      // (Se hace así porque ni `overrideGuard` ni `overrideProvider` interceptan
      // los enhancers registrados con APP_GUARD.)
      skipIf: () =>
        process.env.NODE_ENV === 'test' && process.env.THROTTLE_SKIP === '1',
    }),
    HealthModule,
    IamModule,
    TicketingModule,
  ],
  // Orden de ejecución = orden de registro. El rate limiting va primero: no
  // tiene sentido gastar una comprobación de rol en una petición que ya excedió
  // su cuota.
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
