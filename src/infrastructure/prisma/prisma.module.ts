import { Global, Module } from '@nestjs/common';
import {
  OUTBOX_WRITER,
  PROCESSED_MESSAGES,
  TRANSACTION_MANAGER,
} from '../../shared-kernel';
import { PrismaOutboxWriter } from './prisma-outbox.writer';
import { PrismaProcessedMessages } from './prisma-processed-messages';
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
    PrismaOutboxWriter,
    PrismaProcessedMessages,
    { provide: TRANSACTION_MANAGER, useExisting: PrismaTransactionManager },
    { provide: OUTBOX_WRITER, useExisting: PrismaOutboxWriter },
    { provide: PROCESSED_MESSAGES, useExisting: PrismaProcessedMessages },
  ],
  exports: [
    PrismaService,
    TRANSACTION_MANAGER,
    OUTBOX_WRITER,
    PROCESSED_MESSAGES,
  ],
})
export class PrismaModule {}
