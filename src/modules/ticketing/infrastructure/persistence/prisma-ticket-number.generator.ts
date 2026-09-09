import { Injectable } from '@nestjs/common';
import { PrismaRepository } from '../../../../infrastructure/prisma/prisma.repository';
import { PrismaService } from '../../../../infrastructure/prisma/prisma.service';
import { TenantId } from '../../domain/ids';
import { TicketNumberGenerator } from '../../domain/ports/ticket-number.generator';

@Injectable()
export class PrismaTicketNumberGenerator
  extends PrismaRepository
  implements TicketNumberGenerator
{
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  /**
   * Reserva el siguiente número visible del tenant (ADR-0017).
   *
   * Un solo UPSERT hace las tres cosas que hacían falta: crea la fila del
   * contador la primera vez (así registrarse no tiene que sembrar nada), toma el
   * bloqueo EXCLUSIVO de esa fila —`ON CONFLICT DO UPDATE` adquiere el mismo
   * lock que un `SELECT ... FOR UPDATE`, pero en un único viaje a la base de
   * datos— y devuelve el número asignado.
   *
   * El `RETURNING next_number - 1` es porque la columna guarda el PRÓXIMO
   * número: tras la operación vale N+1, así que el que le toca a este ticket es
   * N. En la primera inserción se escribe 2 y se devuelve 1.
   *
   * Corre dentro de la transacción del caso de uso, de modo que el bloqueo se
   * mantiene hasta el commit: dos altas simultáneas del mismo tenant se
   * serializan aquí y nunca obtienen el mismo número. Tenants distintos tocan
   * filas distintas y no se estorban.
   */
  async next(tenantId: TenantId): Promise<number> {
    return this.runInTenant(tenantId, async (tx) => {
      const rows = await tx.$queryRaw<{ number: number }[]>`
        INSERT INTO ticket_counters (tenant_id, next_number)
        VALUES (${tenantId}::uuid, 2)
        ON CONFLICT (tenant_id)
          DO UPDATE SET next_number = ticket_counters.next_number + 1
        RETURNING next_number - 1 AS number
      `;

      const assigned = rows[0]?.number;
      if (assigned === undefined) {
        // Solo puede pasar si la policy de RLS bloqueó la escritura, es decir si
        // se llamó sin contexto de tenant. Es un bug nuestro, no del cliente.
        throw new Error(
          `No se pudo reservar número de ticket para el tenant ${tenantId}.`,
        );
      }
      return assigned;
    });
  }
}
