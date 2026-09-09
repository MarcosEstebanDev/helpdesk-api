import { Injectable } from '@nestjs/common';
import { ProcessedMessages } from '../../shared-kernel';
import { PrismaRepository } from './prisma.repository';
import { PrismaService } from './prisma.service';

@Injectable()
export class PrismaProcessedMessages
  extends PrismaRepository
  implements ProcessedMessages
{
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  /**
   * Reserva el mensaje apoyándose en la clave primaria `(consumer, event_id)`.
   *
   * Dos detalles que importan:
   *
   * 1. **No es SELECT y luego INSERT.** Entre esas dos operaciones cabe otro
   *    worker, y el evento se procesaría dos veces. El índice único no deja ese
   *    hueco: o inserta, o no; y eso ES la respuesta.
   * 2. **Es `skipDuplicates` (`ON CONFLICT DO NOTHING`) y no un `try/catch`
   *    sobre la violación de unicidad.** En Postgres, un statement que falla
   *    ABORTA la transacción entera: el `catch` se ejecutaría, sí, pero la
   *    siguiente consulta moriría con `current transaction is aborted`. Y aquí
   *    estamos siempre dentro de la transacción del efecto, así que eso se
   *    llevaría por delante todo el job.
   *
   * Al ir por `runInTenant` participa en esa transacción: si el trabajo
   * revierte, la marca revierte con él y el reintento vuelve a intentarlo.
   */
  async claim(input: {
    consumer: string;
    eventId: string;
    tenantId: string;
  }): Promise<boolean> {
    return this.runInTenant(input.tenantId, async (tx) => {
      const inserted = await tx.processedMessage.createMany({
        data: [
          {
            consumer: input.consumer,
            eventId: input.eventId,
            tenantId: input.tenantId,
          },
        ],
        skipDuplicates: true,
      });

      // count === 0 significa que la fila ya estaba: alguien lo procesó antes.
      return inserted.count === 1;
    });
  }
}
