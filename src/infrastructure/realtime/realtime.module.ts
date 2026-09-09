import { Global, Module } from '@nestjs/common';
import { IamModule } from '../../modules/iam/iam.module';
import { REALTIME_PUBLISHER } from '../../shared-kernel';
import { RealtimeGateway } from './realtime.gateway';

/**
 * Transporte de tiempo real (ADR-0022).
 *
 * `@Global` como `PrismaModule` y `QueueModule`: cualquier bounded context que
 * necesite empujar algo a los clientes inyecta el PUERTO `REALTIME_PUBLISHER`
 * sin importar este módulo. Eso además evita el ciclo que aparecería si
 * `ticketing` importara realtime y realtime necesitara algo de ticketing.
 *
 * `useExisting` y no `useClass`: el gateway tiene que ser **la misma instancia**
 * que Nest registró como gateway, o el `@WebSocketServer()` inyectado estaría
 * vacío y las emisiones se perderían en silencio.
 */
@Global()
@Module({
  imports: [IamModule],
  providers: [
    RealtimeGateway,
    { provide: REALTIME_PUBLISHER, useExisting: RealtimeGateway },
  ],
  exports: [REALTIME_PUBLISHER, RealtimeGateway],
})
export class RealtimeModule {}
