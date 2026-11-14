import { Result, TransactionManager, err, ok } from '../../../../shared-kernel';
import {
  SavedViewForbiddenError,
  SavedViewNotFoundError,
  TicketingError,
} from '../../domain/errors';
import { SavedViewId, TenantId, UserId } from '../../domain/ids';
import { SavedViewRepository } from '../../domain/ports/saved-view.repository';
import { runTransactional } from '../transactional';
import { puedeEscribirCompartidas } from './create-saved-view.use-case';

export interface DeleteSavedViewInput {
  tenantId: TenantId;
  actorId: UserId;
  actorRole: string;
  id: SavedViewId;
}

/** Borra una vista (ADR-0033): mismas reglas de visibilidad y permiso que editar. */
export class DeleteSavedView {
  constructor(
    private readonly transactions: TransactionManager,
    private readonly views: SavedViewRepository,
  ) {}

  async execute(
    input: DeleteSavedViewInput,
  ): Promise<Result<void, TicketingError>> {
    return runTransactional<void, TicketingError>(
      this.transactions,
      input.tenantId,
      async () => {
        const vista = await this.views.findVisible(
          input.tenantId,
          input.actorId,
          input.id,
        );
        if (vista === null) return err(new SavedViewNotFoundError());
        if (vista.isShared && !puedeEscribirCompartidas(input.actorRole)) {
          return err(new SavedViewForbiddenError());
        }
        if (!(await this.views.remove(input.tenantId, input.id))) {
          return err(new SavedViewNotFoundError());
        }
        return ok(undefined);
      },
    );
  }
}
