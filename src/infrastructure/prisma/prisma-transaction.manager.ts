import { AsyncLocalStorage } from 'node:async_hooks';
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { TransactionManager } from '../../shared-kernel';
import { PrismaService } from './prisma.service';

/**
 * Transacción activa de la petición en curso (ADR-0016).
 *
 * Se propaga por `AsyncLocalStorage` y no como parámetro de cada método de
 * repositorio por una razón de arquitectura: el parámetro sería del tipo
 * `Prisma.TransactionClient`, así que las INTERFACES de los puertos —que viven
 * en el dominio— tendrían que nombrar un tipo de Prisma. Eso rompe la regla de
 * dependencias (`infrastructure -> application -> domain`) justo en el sitio
 * donde más importa: el dominio dejaría de ser portable.
 */
const activeTransaction = new AsyncLocalStorage<Prisma.TransactionClient>();

/** Transacción en curso, o `null` si la operación va suelta. */
export const getActiveTransaction = (): Prisma.TransactionClient | null =>
  activeTransaction.getStore() ?? null;

@Injectable()
export class PrismaTransactionManager implements TransactionManager {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Abre una transacción con el contexto de tenant fijado y la publica para que
   * los repositorios se enganchen a ella.
   *
   * **Reentrante a propósito.** Si ya hay una transacción viva, se reutiliza en
   * vez de abrir otra. Anidar `withTenant` pediría una SEGUNDA conexión al pool
   * y abriría una transacción independiente: el ticket y su auditoría dejarían
   * de ser atómicos, y con el pool saturado la transacción externa esperaría por
   * una conexión que solo se libera cuando ella misma termine (deadlock).
   */
  async run<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    const current = activeTransaction.getStore();
    if (current !== undefined) {
      return fn();
    }

    return this.prisma.withTenant(tenantId, (tx) =>
      activeTransaction.run(tx, fn),
    );
  }
}
