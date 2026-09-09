import { Global, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema';
import { DEAD_LETTER_QUEUE, TICKET_ROUTING_QUEUE } from './queues';

/**
 * Conexión a Redis y registro de colas (ADR-0019).
 *
 * `@Global` para que cualquier bounded context inyecte sus colas sin volver a
 * importar el módulo, igual que `PrismaModule`.
 *
 * La URL se lee de la configuración validada con Zod: si falta `REDIS_URL`, la
 * app no arranca. Es deliberado — arrancar sin colas dejaría los eventos del
 * outbox acumulándose en silencio, que es peor que no arrancar.
 */
@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [ConfigService],
      // El tipo de retorno se anota a mano: `SharedBullConfigurationFactory`
      // devuelve `any` para su `connection`, y sin la anotación la regla
      // `no-unsafe-assignment` marca el objeto entero como inseguro.
      useFactory: (
        config: ConfigService<Env, true>,
      ): { connection: { url: string } } => ({
        connection: { url: config.get('REDIS_URL', { infer: true }) },
      }),
    }),
    BullModule.registerQueue(
      { name: TICKET_ROUTING_QUEUE },
      { name: DEAD_LETTER_QUEUE },
    ),
  ],
  exports: [BullModule],
})
export class QueueModule {}
