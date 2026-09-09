import { Global, Module } from '@nestjs/common';
import { TRANSACTION_MANAGER } from '../../shared-kernel';
import { PrismaTransactionManager } from './prisma-transaction.manager';
import { PrismaService } from './prisma.service';

/**
 * Acceso a la base de datos, transversal a todos los bounded contexts. Es
 * `@Global` para que cualquier adapter (repos Prisma) inyecte `PrismaService`
 * sin reimportar el módulo en cada feature.
 */
@Global()
@Module({
  providers: [
    PrismaService,
    PrismaTransactionManager,
    { provide: TRANSACTION_MANAGER, useExisting: PrismaTransactionManager },
  ],
  exports: [PrismaService, TRANSACTION_MANAGER],
})
export class PrismaModule {}
