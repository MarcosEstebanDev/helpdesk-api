import type { Prisma } from '@prisma/client';
import { getActiveTransaction } from './prisma-transaction.manager';
import { PrismaService } from './prisma.service';

/**
 * Base de los repositorios Prisma que deben poder participar en una unidad de
 * trabajo mayor (ADR-0016).
 *
 * `runInTenant` es el único punto donde un repositorio decide cómo hablar con la
 * base de datos:
 *
 * - Si hay una transacción abierta por el `TransactionManager`, se engancha a
 *   ella. El `set_config('app.current_tenant', ...)` ya se hizo al abrirla, así
 *   que RLS sigue aplicando.
 * - Si no la hay —una lectura suelta, por ejemplo— abre su propia `withTenant`,
 *   igual que los repositorios de `iam`.
 *
 * El resultado es que el mismo repositorio sirve para las dos cosas y ningún
 * caso de uso tiene que saber en cuál de los dos modos está corriendo.
 */
export abstract class PrismaRepository {
  protected constructor(protected readonly prisma: PrismaService) {}

  protected runInTenant<T>(
    tenantId: string,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    const active = getActiveTransaction();
    return active !== null ? fn(active) : this.prisma.withTenant(tenantId, fn);
  }
}
