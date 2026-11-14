import {
  Clock,
  Result,
  TransactionManager,
  err,
  ok,
} from '../../../../shared-kernel';
import { TagNotFoundError, TicketingError } from '../../domain/errors';
import { TagId, TenantId, UserId } from '../../domain/ids';
import { TagRepository } from '../../domain/ports/tag.repository';
import { AuditRecorder } from '../audit-recorder';
import { runTransactional } from '../transactional';

export interface DeleteTagInput {
  tenantId: TenantId;
  actorId: UserId;
  id: TagId;
}

/**
 * Borra una etiqueta del catálogo y, por cascada, de todos sus tickets
 * (ADR-0031, solo ADMIN). No emite un evento por ticket —sería una tormenta—:
 * el front invalida su caché al borrar. El historial de cada ticket conserva
 * el nombre, porque `ticket.tags_changed` lo guardó en su `metadata`.
 */
export class DeleteTag {
  constructor(
    private readonly transactions: TransactionManager,
    private readonly tags: TagRepository,
    private readonly audit: AuditRecorder,
    private readonly clock: Clock,
  ) {}

  async execute(input: DeleteTagInput): Promise<Result<void, TicketingError>> {
    return runTransactional<void, TicketingError>(
      this.transactions,
      input.tenantId,
      async () => {
        const tag = await this.tags.findById(input.tenantId, input.id);
        if (tag === null) return err(new TagNotFoundError());

        // Se mira el resultado de `remove` y no solo `findById`: si otro ADMIN
        // la borró entre medio, no se escribe una segunda entrada de auditoría.
        if (!(await this.tags.remove(input.tenantId, input.id))) {
          return err(new TagNotFoundError());
        }
        await this.audit.record({
          tenantId: input.tenantId,
          actorId: input.actorId,
          action: 'tag.deleted',
          entityType: 'Tag',
          entityId: tag.id,
          metadata: { name: tag.name, color: tag.color },
          now: this.clock.now(),
        });
        return ok(undefined);
      },
    );
  }
}
