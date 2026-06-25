import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';

/**
 * Cliente Prisma gestionado por el ciclo de vida de Nest.
 *
 * El método clave es {@link withTenant}: abre una transacción y fija
 * `app.current_tenant` mediante `set_config(..., is_local => true)`, de modo que
 * las policies de Row-Level Security (ADR-0010) vean el tenant correcto. Al ser
 * `is_local = true`, el valor SOLO vive dentro de esa transacción: aunque el pool
 * reutilice la conexión, ningún otro request hereda el contexto de tenant.
 *
 * Regla de oro (ver modelo de seguridad): el `tenantId` que entra acá SIEMPRE
 * proviene del JWT autenticado, nunca del body/params/query. Acá se parametriza
 * (nunca se concatena) para evitar inyección sobre el GUC.
 */
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Prisma conectado');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /**
   * Ejecuta `fn` dentro de una transacción con el contexto de tenant fijado.
   * Todas las queries que use `fn` (sobre el `tx` recibido) quedan filtradas por
   * RLS al tenant indicado.
   */
  async withTenant<T>(
    tenantId: string,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.$transaction(async (tx) => {
      // Parametrizado: el tenantId viaja como bind param, no como literal SQL.
      await tx.$executeRaw`SELECT set_config('app.current_tenant', ${tenantId}, true)`;
      return fn(tx);
    });
  }
}
