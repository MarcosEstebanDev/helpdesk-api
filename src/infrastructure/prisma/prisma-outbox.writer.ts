import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { OutboxRecord, OutboxWriter } from '../../shared-kernel';
import { PrismaRepository } from './prisma.repository';
import { PrismaService } from './prisma.service';

@Injectable()
export class PrismaOutboxWriter
  extends PrismaRepository
  implements OutboxWriter
{
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  /**
   * Inserta los mensajes en el outbox.
   *
   * Va por `runInTenant`, así que se engancha a la transacción que el caso de uso
   * ya tiene abierta (ADR-0016). Es justo lo que hace que el patrón funcione: los
   * eventos y el cambio que los provoca comparten commit.
   *
   * Todos los registros de una llamada vienen del MISMO agregado y por tanto del
   * mismo tenant. Se comprueba en vez de darlo por hecho porque, si algún día
   * dejara de ser cierto, RLS rechazaría la fila intrusa con un error de policy
   * bastante opaco; así el fallo dice qué pasó.
   */
  async append(records: readonly OutboxRecord[]): Promise<void> {
    if (records.length === 0) {
      return;
    }

    const tenantId = records[0].tenantId;
    if (records.some((record) => record.tenantId !== tenantId)) {
      throw new Error(
        'Un lote del outbox no puede mezclar tenants: el contexto de RLS es uno solo.',
      );
    }

    await this.runInTenant(tenantId, async (tx) => {
      await tx.outboxMessage.createMany({
        data: records.map((record) => ({
          id: record.id,
          tenantId: record.tenantId,
          aggregateType: record.aggregateType,
          aggregateId: record.aggregateId,
          eventName: record.eventName,
          version: record.version,
          payload: record.payload as Prisma.InputJsonValue,
          occurredAt: record.occurredAt,
        })),
      });
    });
  }
}
