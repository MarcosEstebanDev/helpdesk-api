import {
  Clock,
  Result,
  TransactionManager,
  err,
  ok,
} from '../../../../shared-kernel';
import {
  TagNotFoundError,
  TicketClosedError,
  TicketNotFoundError,
  TicketingError,
} from '../../domain/errors';
import { TagId, TenantId, TicketId, UserId } from '../../domain/ids';
import { TagRepository } from '../../domain/ports/tag.repository';
import { TicketTagRepository } from '../../domain/ports/ticket-tag.repository';
import { TicketRepository } from '../../domain/ports/ticket.repository';
import { Tag } from '../../domain/tag/tag.entity';
import { diffTagSets } from '../../domain/tag/tag-set';
import { isTerminal } from '../../domain/ticket-status';
import { AuditRecorder } from '../audit-recorder';
import { EventRecorder } from '../event-recorder';
import { runTransactional } from '../transactional';

export interface SetTicketTagsInput {
  tenantId: TenantId;
  actorId: UserId;
  ticketId: TicketId;
  tagIds: TagId[];
}

const porNombre = (tags: Tag[]): Tag[] =>
  [...tags].sort((a, b) => a.nameKey.localeCompare(b.nameKey));

/**
 * Reemplaza las etiquetas de un ticket (ADR-0031). Devuelve las resultantes.
 *
 * Si dos agentes lo hacen a la vez, gana el último (decisión del spec), y la
 * fila del ticket se BLOQUEA para que eso sea literal: el segundo espera al
 * primero y calcula su diff sobre lo que el primero dejó. El cambio, su auditoría y el evento van en la
 * MISMA transacción (ADR-0016), y la auditoría guarda los NOMBRES para que el
 * historial se lea aunque la etiqueta se renombre o se borre después.
 */
export class SetTicketTags {
  constructor(
    private readonly transactions: TransactionManager,
    private readonly tickets: TicketRepository,
    private readonly tags: TagRepository,
    private readonly ticketTags: TicketTagRepository,
    private readonly audit: AuditRecorder,
    private readonly events: EventRecorder,
    private readonly clock: Clock,
  ) {}

  async execute(
    input: SetTicketTagsInput,
  ): Promise<Result<Tag[], TicketingError>> {
    return runTransactional<Tag[], TicketingError>(
      this.transactions,
      input.tenantId,
      async () => {
        // BLOQUEADO hasta el commit (revisión final). Sin esto, dos cosas:
        // dos `PUT` a la vez chocaban en la PK de `ticket_tags` (500), y otro
        // agente podía cerrar el ticket entre esta lectura y el `save`, que lo
        // reescribía entero con el estado viejo y lo reabría. Con el bloqueo,
        // quien llega segundo espera y lee lo que dejó el primero.
        const ticket = await this.tickets.findByIdForUpdate(
          input.tenantId,
          input.ticketId,
        );
        if (ticket === null) return err(new TicketNotFoundError());
        if (isTerminal(ticket.status)) return err(new TicketClosedError());

        const actuales = await this.ticketTags.tagsOf(
          input.tenantId,
          input.ticketId,
        );
        const diff = diffTagSets(actuales, input.tagIds);
        if (diff.isErr()) return err(diff.error);
        const { next, added, removed } = diff.value;

        // Se cargan las nuevas Y las que se quitan: de las segundas hace falta
        // el nombre para la auditoría. Un id pedido que no aparece no existe en
        // esta organización (RLS lo hace invisible si es de otra).
        const conocidas = await this.tags.findByIds(input.tenantId, [
          ...new Set([...next, ...removed]),
        ]);
        const porId = new Map(conocidas.map((t) => [t.id, t]));
        if (next.some((id) => !porId.has(id))) {
          return err(new TagNotFoundError());
        }
        const resultantes = porNombre(next.map((id) => porId.get(id) as Tag));

        if (added.length === 0 && removed.length === 0) {
          return ok(resultantes);
        }

        const now = this.clock.now();
        await this.ticketTags.replace(input.tenantId, input.ticketId, next);
        ticket.recordTagsChanged(added, removed, now);
        await this.tickets.save(ticket);

        const resumen = (ids: TagId[]) =>
          ids.map((id) => ({ id, name: porId.get(id)?.name ?? null }));
        await this.audit.record({
          tenantId: input.tenantId,
          actorId: input.actorId,
          action: 'ticket.tags_changed',
          entityType: 'ticket',
          entityId: ticket.id,
          metadata: { added: resumen(added), removed: resumen(removed) },
          now,
        });
        await this.events.record(ticket);

        return ok(resultantes);
      },
    );
  }
}
