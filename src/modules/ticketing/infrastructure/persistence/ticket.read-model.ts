import { Inject, Injectable } from '@nestjs/common';
import { CLOCK } from '../../../../shared-kernel';
// `import type` obligado: `Clock` se usa en una propiedad DECORADA y con
// `emitDecoratorMetadata` + `isolatedModules` el compilador necesita saber que
// el símbolo no existe en tiempo de ejecución (TS1272).
import type { Clock } from '../../../../shared-kernel';
import { PrismaRepository } from '../../../../infrastructure/prisma/prisma.repository';
import { PrismaService } from '../../../../infrastructure/prisma/prisma.service';
import { CommentVisibility, visibleTo } from '../../domain/comment-visibility';
import { TenantId, TicketId } from '../../domain/ids';
import {
  SlaTimerView,
  describeSlaTimer,
  isSlaKind,
} from '../../domain/sla/sla-timer.entity';
import { TicketPriority, TicketStatus } from '../../domain/ticket-status';

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
      limit: number;
      cursor?: string;
    },
  ): Promise<TicketPage> {
    const take = Math.min(Math.max(options.limit, 1), TICKETS_PAGE_SIZE_MAX);

    return this.runInTenant(tenantId, async (tx) => {
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
        },
      });

      const items: TicketListItem[] = rows.map(({ triage, ...ticket }) =>
        options.withTriage === true ? { ...ticket, aiTriage: triage } : ticket,
      );

      return {
        items,
        // Solo hay cursor si la página vino llena: si vino corta, no queda nada.
        nextCursor:
          rows.length === take ? (rows[rows.length - 1]?.id ?? null) : null,
      };
    });
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
            },
          },
        },
      });
      if (row === null) return null;

      const now = this.clock.now();
      const { slaTimers, ...ticket } = row;

      return {
        ...ticket,
        // La regla de qué significa cada combinación de fechas es del dominio y
        // se aplica aquí, no se reescribe: ver `describeSlaTimer`.
        sla: slaTimers
          .filter((timer) => isSlaKind(timer.kind))
          .map((timer) =>
            describeSlaTimer({ ...timer, kind: timer.kind, pausedAt: null }, now),
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
