import {
  Clock,
  Result,
  TransactionManager,
  err,
  ok,
} from '../../../../shared-kernel';
import {
  DuplicateTagNameError,
  TagNotFoundError,
  TicketingError,
} from '../../domain/errors';
import { TagId, TenantId, UserId } from '../../domain/ids';
import { TagRepository } from '../../domain/ports/tag.repository';
import { Tag } from '../../domain/tag/tag.entity';
import { AuditRecorder } from '../audit-recorder';
import { runTransactional } from '../transactional';

export interface UpdateTagInput {
  tenantId: TenantId;
  actorId: UserId;
  id: TagId;
  name?: string;
  color?: string;
}

/**
 * Renombra o recolorea una etiqueta (ADR-0031, solo ADMIN). No toca ningún
 * ticket: la relación apunta al id. El historial de los tickets conserva el
 * nombre que tenía al etiquetarlos.
 */
export class UpdateTag {
  constructor(
    private readonly transactions: TransactionManager,
    private readonly tags: TagRepository,
    private readonly audit: AuditRecorder,
    private readonly clock: Clock,
  ) {}

  async execute(input: UpdateTagInput): Promise<Result<Tag, TicketingError>> {
    return runTransactional<Tag, TicketingError>(
      this.transactions,
      input.tenantId,
      async () => {
        const tag = await this.tags.findById(input.tenantId, input.id);
        if (tag === null) return err(new TagNotFoundError());

        const antes = { name: tag.name, color: tag.color };
        const now = this.clock.now();
        if (input.name !== undefined) {
          const r = tag.rename(input.name, now);
          if (r.isErr()) return err(r.error);
        }
        if (input.color !== undefined) {
          const r = tag.recolor(input.color, now);
          if (r.isErr()) return err(r.error);
        }

        const despues = { name: tag.name, color: tag.color };
        if (antes.name === despues.name && antes.color === despues.color) {
          return ok(tag);
        }

        if (
          await this.tags.existsNameKey(input.tenantId, tag.nameKey, tag.id)
        ) {
          return err(new DuplicateTagNameError());
        }

        await this.tags.update(tag);
        await this.audit.record({
          tenantId: input.tenantId,
          actorId: input.actorId,
          action: 'tag.updated',
          entityType: 'Tag',
          entityId: tag.id,
          metadata: { before: antes, after: despues },
          now,
        });
        return ok(tag);
      },
    );
  }
}
