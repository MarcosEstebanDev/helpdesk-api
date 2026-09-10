import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/** Un mensaje reclamado del outbox, listo para encolar. */
export interface ClaimedMessage {
  id: string;
  tenantId: string;
  aggregateType: string;
  aggregateId: string;
  eventName: string;
  version: number;
  payload: Record<string, unknown>;
  occurredAt: Date;
  /** Petición HTTP que originó el evento (ADR-0024); `null` si nació sin una. */
  requestId: string | null;
}

/** Forma cruda que devuelve la función SQL (snake_case, `version` como bigint). */
interface ClaimedRow {
  id: string;
  tenant_id: string;
  aggregate_type: string;
  aggregate_id: string;
  event_name: string;
  version: number;
  payload: Record<string, unknown>;
  occurred_at: Date;
  request_id: string | null;
}

/**
 * Acceso del publicador al outbox (ADR-0019).
 *
 * NO usa `withTenant`: el publicador corre fuera de toda request y debe ver los
 * mensajes de TODOS los tenants. Como las policies son fail-closed, sin contexto
 * no vería ninguna fila; por eso pasa por las funciones `SECURITY DEFINER` que
 * pertenecen a `helpdesk_outbox_publisher`, un rol NOLOGIN, sin BYPASSRLS y con
 * permisos a nivel de columna sobre esta única tabla.
 *
 * Es la misma solución de mínimo privilegio del ADR-0012 para el login por slug.
 */
@Injectable()
export class OutboxReader {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Reclama un lote y ejecuta `fn` con él DENTRO de la transacción que sostiene
   * los bloqueos de `FOR UPDATE SKIP LOCKED`.
   *
   * El bloqueo es lo que permite tener varias instancias publicando a la vez sin
   * duplicar trabajo: cada una se lleva filas distintas. Vive hasta el commit,
   * así que `fn` debe encolar y marcar rápido — no es sitio para esperas largas.
   */
  async withClaimedBatch<T>(
    options: { limit: number; maxAttempts: number },
    fn: (messages: ClaimedMessage[], marker: OutboxMarker) => Promise<T>,
  ): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      // Los `::int` no son decorativos: Prisma envía los números de JavaScript
      // como `bigint`, y sin el cast Postgres busca `outbox_claim_batch(bigint,
      // bigint)`, que no existe (42883).
      const rows = await tx.$queryRaw<ClaimedRow[]>`
        SELECT * FROM outbox_claim_batch(
          ${options.limit}::int,
          ${options.maxAttempts}::int
        )
      `;

      const messages: ClaimedMessage[] = rows.map((row) => ({
        id: row.id,
        tenantId: row.tenant_id,
        aggregateType: row.aggregate_type,
        aggregateId: row.aggregate_id,
        eventName: row.event_name,
        version: Number(row.version),
        payload: row.payload,
        occurredAt: row.occurred_at,
        requestId: row.request_id,
      }));

      const marker: OutboxMarker = {
        markPublished: async (ids) => {
          if (ids.length === 0) return;
          await tx.$executeRaw`SELECT outbox_mark_published(${ids}::uuid[])`;
        },
        markFailed: async (id, error) => {
          await tx.$executeRaw`SELECT outbox_mark_failed(${id}::uuid, ${error})`;
        },
      };

      return fn(messages, marker);
    });
  }
}

/** Marcado del resultado, atado a la transacción del lote reclamado. */
export interface OutboxMarker {
  markPublished(ids: string[]): Promise<void>;
  markFailed(id: string, error: string): Promise<void>;
}
