import {
  Clock,
  IdGenerator,
  Result,
  TransactionManager,
  err,
  ok,
} from '../../../../shared-kernel';
import { DuplicateTagNameError, TicketingError } from '../../domain/errors';
import { TagId, TenantId, UserId } from '../../domain/ids';
import { TagRepository } from '../../domain/ports/tag.repository';
import { Tag } from '../../domain/tag/tag.entity';
import { AuditRecorder } from '../audit-recorder';
import { runTransactional } from '../transactional';

export interface CreateTagInput {
  tenantId: TenantId;
  actorId: UserId;
  name: string;
  color?: string;
}

/**
 * Crea una etiqueta del catálogo (ADR-0031). La puede crear un AGENT —al vuelo,
 * mientras etiqueta un ticket—; el rango lo comprueba el borde HTTP.
 */
export class CreateTag {
  constructor(
    private readonly transactions: TransactionManager,
    private readonly tags: TagRepository,
    private readonly audit: AuditRecorder,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async execute(input: CreateTagInput): Promise<Result<Tag, TicketingError>> {
    const now = this.clock.now();
    const creada = Tag.create({
      id: TagId(this.ids.uuid()),
      tenantId: input.tenantId,
      name: input.name,
      color: input.color,
      now,
    });
    if (creada.isErr()) return err(creada.error);
    const tag = creada.value;

    return runTransactional<Tag, TicketingError>(
      this.transactions,
      input.tenantId,
      async () => {
        if (await this.tags.existsNameKey(input.tenantId, tag.nameKey)) {
          return err(new DuplicateTagNameError());
        }
        await this.tags.insert(tag);
        await this.audit.record({
          tenantId: input.tenantId,
          actorId: input.actorId,
          action: 'tag.created',
          entityType: 'Tag',
          entityId: tag.id,
          metadata: { name: tag.name, color: tag.color },
          now,
        });
        return ok(tag);
      },
    );
  }
}
