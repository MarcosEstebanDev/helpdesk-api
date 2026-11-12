import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CLOCK } from '../../../../shared-kernel';
// `import type` obligado: `Clock` se usa en una propiedad DECORADA y con
// `emitDecoratorMetadata` + `isolatedModules` el compilador necesita saber que
// el símbolo no existe en tiempo de ejecución (TS1272).
import type { Clock } from '../../../../shared-kernel';
import { PrismaRepository } from '../../../../infrastructure/prisma/prisma.repository';
import { PrismaService } from '../../../../infrastructure/prisma/prisma.service';
import {
  CommentVisibility,
  isStaff,
  visibleTo,
} from '../../domain/comment-visibility';
import {
  FilaDeEtiqueta,
  TAG_SELECT,
  TagView,
  aVistasDeEtiquetas,
} from './tag-view';

export type { TagView } from './tag-view';
import { TenantId, TicketId } from '../../domain/ids';
import {
  SlaTimerView,
  describeSlaTimer,
  isSlaKind,
} from '../../domain/sla/sla-timer.entity';
import { TicketPriority, TicketStatus } from '../../domain/ticket-status';
import { parseSearch } from '../../domain/search/search-query';

/**
 * Tope de coincidencias de una búsqueda (ADR-0032): las más recientes. Para
 * encontrar un ticket concreto alcanza de sobra, y evita mandar a Prisma una
 * lista de ids sin límite.
 */
export const SEARCH_MATCH_LIMIT = 1000;

/**
 * Lado de LECTURA del contexto Ticketing (CQRS-lite, ADR-0008).
 *
 * No pasa por el dominio ni por los repositorios: consulta Prisma y devuelve
 * directamente la forma que la API necesita. Hacerlo con el agregado obligaría a
 * rehidratar entidades completas para luego aplanarlas, y a añadir a los puertos
 * un método de búsqueda por cada filtro que pida el front.
 *
 * Vive en `infrastructure/` justamente porque conoce Prisma: si estuviera en
 * `application/` rompería la regla de dependencias. El controller lo inyecta
 * directamente para las consultas, y usa los casos de uso para las escrituras.
 */

export interface TicketSummary {
  id: string;
  number: number;
  subject: string;
  status: TicketStatus;
  priority: TicketPriority;
  requesterId: string;
  assigneeId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Lo justo de la sugerencia de la IA para pintar la bandeja (ADR-0027). */
export interface TicketTriageSummary {
  category: string;
  suggestedPriority: TicketPriority;
}

/**
 * Fila de la bandeja. `aiTriage` solo EXISTE para AGENT o superior: para un
 * VIEWER la clave ni aparece (no es `null`, que significaría "sin sugerencia").
 */
export interface TicketListItem extends TicketSummary {
  aiTriage?: TicketTriageSummary | null;
  /** Solo para el equipo: para un VIEWER la clave NO existe (ADR-0031). */
  tags?: TagView[];
}

/**
 * Para cada prioridad, las que son MÁS urgentes. Es la traducción a Prisma de
 * "la IA sugiere más urgencia que la actual": comparar dos columnas de tablas
 * distintas no se puede expresar en su `where`, pero un OR de tres casos sí, y
 * así el filtro convive con la paginación por cursor sin SQL a mano.
 */
const MAS_URGENTES: Record<TicketPriority, TicketPriority[]> = {
  LOW: ['NORMAL', 'HIGH', 'URGENT'],
  NORMAL: ['HIGH', 'URGENT'],
  HIGH: ['URGENT'],
  URGENT: [],
};

export interface TicketPage {
  items: TicketListItem[];
  /** Id del último elemento; se pasa como `cursor` para pedir la página siguiente. */
  nextCursor: string | null;
}

export interface TicketDetail extends TicketSummary {
  description: string;
  resolvedAt: Date | null;
  closedAt: Date | null;
  comments: {
    id: string;
    authorId: string;
    body: string;
    visibility: CommentVisibility;
    createdAt: Date;
  }[];
  /**
   * Estado de sus relojes de SLA (fase 6). Va vacío en los tickets anteriores a
   * esa fase y en los que el worker todavía no ha procesado: el detalle no
   * miente diciendo que cumplen, simplemente no hay relojes que enseñar.
   */
  sla: SlaTimerView[];
  /** Solo para el equipo: para un VIEWER la clave NO existe (ADR-0031). */
  tags?: TagView[];
}

export interface AuditEntryView {
  id: string;
  actorId: string;
  action: string;
  metadata: unknown;
  occurredAt: Date;
}

export type TicketTriageView =
  | { status: 'pending' }
  | {
      status: 'ready';
      category: string;
      suggestedPriority: TicketPriority;
      sentiment: string;
      language: string;
      model: string;
      promptVersion: string;
      triagedAt: Date;
    };

export const TICKETS_PAGE_SIZE_MAX = 100;

@Injectable()
export class TicketReadModel extends PrismaRepository {
  constructor(
    prisma: PrismaService,
    // El lado de lectura necesita la hora para decir cuánto margen queda. Sale
    // del puerto y no de `new Date()` para que los tests puedan fijarla.
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    super(prisma);
  }

  /**
   * Listado paginado.
   *
   * Paginación por CURSOR y no por `skip`/`offset`: con offset, el motor tiene
   * que recorrer y descartar las filas anteriores —cada vez más caro según se
   * avanza— y una alta concurrente desplaza los resultados, de modo que un
   * elemento puede aparecer dos veces o ninguna. El cursor apunta a una fila
   * concreta y ninguna de las dos cosas ocurre.
   *
   * El `orderBy` incluye `id` como desempate porque `created_at` no es único: sin
   * él, dos tickets creados en el mismo milisegundo tendrían un orden inestable y
   * el cursor podría saltarse uno.
   */
  async list(
    tenantId: TenantId,
    options: {
      status?: TicketStatus;
      assigneeId?: string;
      requesterId?: string;
      /** Incluir la sugerencia de la IA en cada fila (solo AGENT o superior). */
      withTriage?: boolean;
      /** Solo tickets donde la IA sugiere más urgencia que la actual. */
      aiSuggestsHigher?: boolean;
      /** Incluir las etiquetas de cada fila (solo AGENT o superior). */
      withTags?: boolean;
      /** Tickets con AL MENOS UNA de estas etiquetas (ADR-0031). */
      tagIds?: string[];
      /** Texto libre (ADR-0032). El rol decide si las notas internas cuentan. */
      search?: { text: string; viewerRole: string };
      limit: number;
      cursor?: string;
    },
  ): Promise<TicketPage> {
    const take = Math.min(Math.max(options.limit, 1), TICKETS_PAGE_SIZE_MAX);

    return this.runInTenant(tenantId, async (tx) => {
      // Prisma no admite `@@` en `where`: los ids que coinciden salen de SQL y
      // entran al `findMany` de siempre, junto con los demás filtros y el cursor.
      const coincidencias =
        options.search === undefined
          ? undefined
          : await this.idsQueCoinciden(tx, tenantId, options.search);
      if (coincidencias !== undefined && coincidencias.length === 0) {
        return { items: [], nextCursor: null };
      }

      const rows = await tx.ticket.findMany({
        where: {
          tenantId,
          ...(options.status === undefined ? {} : { status: options.status }),
          ...(options.assigneeId === undefined
            ? {}
            : { assigneeId: options.assigneeId }),
          ...(options.requesterId === undefined
            ? {}
            : { requesterId: options.requesterId }),
          ...(options.aiSuggestsHigher === true
            ? {
                OR: (['LOW', 'NORMAL', 'HIGH'] as const).map((priority) => ({
                  priority,
                  triage: {
                    is: { suggestedPriority: { in: MAS_URGENTES[priority] } },
                  },
                })),
              }
            : {}),
          // `some` y no un JOIN a mano: un ticket con dos de las etiquetas
          // pedidas sale UNA vez. Ids que no existen simplemente no coinciden
          // (una vista guardada con una etiqueta borrada no se rompe).
          ...(options.tagIds === undefined || options.tagIds.length === 0
            ? {}
            : { tags: { some: { tagId: { in: options.tagIds } } } }),
          ...(coincidencias === undefined ? {} : { id: { in: coincidencias } }),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        // `skip: 1` porque el cursor es el ÚLTIMO elemento ya entregado.
        ...(options.cursor === undefined
          ? {}
          : { cursor: { id: options.cursor }, skip: 1 }),
        take,
        select: {
          id: true,
          number: true,
          subject: true,
          status: true,
          priority: true,
          requesterId: true,
          assigneeId: true,
          createdAt: true,
          updatedAt: true,
          // Una relación 1:1 en `select`: Prisma la resuelve con UNA consulta
          // `IN (...)` para toda la página, no una por fila.
          triage: { select: { category: true, suggestedPriority: true } },
          ...(options.withTags === true ? { tags: TAG_SELECT } : {}),
        },
      });

      const items: TicketListItem[] = rows.map((row) => {
        const { triage, ...resto } = row;
        const { tags, ...ticket } = resto as typeof resto & {
          tags?: FilaDeEtiqueta[];
        };
        return {
          ...ticket,
          ...(options.withTriage === true ? { aiTriage: triage } : {}),
          ...(tags === undefined ? {} : { tags: aVistasDeEtiquetas(tags) }),
        };
      });

      return {
        items,
        // Solo hay cursor si la página vino llena: si vino corta, no queda nada.
        nextCursor:
          rows.length === take ? (rows[rows.length - 1]?.id ?? null) : null,
      };
    });
  }

  /**
   * Ids de los tickets que coinciden con la búsqueda (ADR-0032), los más
   * recientes primero. `undefined` si el texto no tiene nada que buscar (el
   * filtro no aplica); `[]` si busca y no encuentra.
   *
   * Un comentario cuenta solo si el rol puede verlo (`visibleTo`): un cliente
   * no encuentra un ticket por una palabra que solo está en una nota interna.
   */
  private async idsQueCoinciden(
    tx: Prisma.TransactionClient,
    tenantId: TenantId,
    search: { text: string; viewerRole: string },
  ): Promise<string[] | undefined> {
    const { tsquery, number } = parseSearch(search.text);
    if (tsquery === null && number === null) return undefined;

    const porNumero =
      number === null ? Prisma.sql`FALSE` : Prisma.sql`t.number = ${number}`;
    const visibles = [...visibleTo(search.viewerRole)];
    const porTexto =
      tsquery === null
        ? Prisma.sql`FALSE`
        : Prisma.sql`(
            t.search_vector @@ to_tsquery('spanish', helpdesk_unaccent(${tsquery}))
            OR EXISTS (
              SELECT 1 FROM comments c
              WHERE c.ticket_id = t.id
                AND c.tenant_id = t.tenant_id
                AND c.visibility::text = ANY(${visibles}::text[])
                AND c.search_vector @@ to_tsquery('spanish', helpdesk_unaccent(${tsquery}))
            )
          )`;

    const filas = await tx.$queryRaw<{ id: string }[]>`
      SELECT t.id FROM tickets t
      WHERE t.tenant_id = ${tenantId}::uuid AND (${porNumero} OR ${porTexto})
      ORDER BY t.created_at DESC, t.id DESC
      LIMIT ${SEARCH_MATCH_LIMIT}`;
    return filas.map((f) => f.id);
  }

  /**
   * `viewerRole` decide qué parte de la conversación se devuelve (ADR-0028): al
   * cliente, sin las notas internas. El filtro va en el WHERE y no después en
   * memoria, así una nota que el cliente no puede ver ni siquiera sale de la base.
   */
  async detail(
    tenantId: TenantId,
    ticketId: TicketId,
    viewerRole: string,
  ): Promise<TicketDetail | null> {
    return this.runInTenant(tenantId, async (tx) => {
      const row = await tx.ticket.findFirst({
        where: { id: ticketId, tenantId },
        include: {
          comments: {
            where: { visibility: { in: [...visibleTo(viewerRole)] } },
            orderBy: { createdAt: 'asc' },
            select: {
              id: true,
              authorId: true,
              body: true,
              visibility: true,
              createdAt: true,
            },
          },
          slaTimers: {
            select: {
              kind: true,
              dueAt: true,
              stoppedAt: true,
              breachedAt: true,
              pausedAt: true,
            },
          },
          // Las etiquetas son clasificación INTERNA: al cliente ni se le leen.
          ...(isStaff(viewerRole) ? { tags: TAG_SELECT } : {}),
        },
      });
      if (row === null) return null;

      const now = this.clock.now();
      const { slaTimers, ...resto } = row;
      const { tags, ...ticket } = resto as typeof resto & {
        tags?: FilaDeEtiqueta[];
      };

      return {
        ...ticket,
        ...(tags === undefined ? {} : { tags: aVistasDeEtiquetas(tags) }),
        // La regla de qué significa cada combinación de fechas es del dominio y
        // se aplica aquí, no se reescribe: ver `describeSlaTimer`.
        sla: slaTimers
          .filter((timer) => isSlaKind(timer.kind))
          .map((timer) =>
            describeSlaTimer({ ...timer, kind: timer.kind }, now),
          ),
      };
    });
  }

  /**
   * Sugerencia de triage de un ticket (ADR-0027). `null` si el ticket no existe
   * (o es de otro tenant: RLS lo hace invisible), `pending` si aún no hay.
   *
   * Selección campo a campo y SIN tokens ni latencia: eso es telemetría para
   * las métricas, no información para quien atiende el ticket.
   */
  async triage(
    tenantId: TenantId,
    ticketId: TicketId,
  ): Promise<TicketTriageView | null> {
    return this.runInTenant(tenantId, async (tx) => {
      const row = await tx.ticket.findFirst({
        where: { id: ticketId, tenantId },
        select: {
          triage: {
            select: {
              category: true,
              suggestedPriority: true,
              sentiment: true,
              language: true,
              model: true,
              promptVersion: true,
              triagedAt: true,
            },
          },
        },
      });
      if (row === null) return null;
      if (row.triage === null) return { status: 'pending' };
      return { status: 'ready', ...row.triage };
    });
  }

  /** Historial de auditoría de un ticket (ADR-0016), del más reciente al más antiguo. */
  async history(
    tenantId: TenantId,
    ticketId: TicketId,
  ): Promise<AuditEntryView[]> {
    return this.runInTenant(tenantId, async (tx) => {
      const rows = await tx.auditLog.findMany({
        where: { tenantId, entityType: 'ticket', entityId: ticketId },
        orderBy: { occurredAt: 'desc' },
        select: {
          id: true,
          actorId: true,
          action: true,
          metadata: true,
          occurredAt: true,
        },
      });
      return rows;
    });
  }
}
