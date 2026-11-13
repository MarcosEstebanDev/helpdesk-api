import {
  Clock,
  Result,
  TransactionManager,
  err,
  ok,
} from '../../../../shared-kernel';
import {
  DuplicateSavedViewNameError,
  SavedViewForbiddenError,
  SavedViewNotFoundError,
  TicketingError,
} from '../../domain/errors';
import { SavedViewId, TenantId, UserId } from '../../domain/ids';
import { SavedViewRepository } from '../../domain/ports/saved-view.repository';
import { SavedView } from '../../domain/saved-view/saved-view.entity';
import { runTransactional } from '../transactional';
import { puedeEscribirCompartidas } from './create-saved-view.use-case';

export interface UpdateSavedViewInput {
  tenantId: TenantId;
  actorId: UserId;
  actorRole: string;
  id: SavedViewId;
  name: string;
  filters: unknown;
}

/**
 * Reemplaza nombre y filtros (ADR-0033). La personal de otro es invisible
 * (not found, aunque quien pide sea ADMIN); una compartida solo la cambia un
 * ADMIN. Personal o compartida no cambia: para eso se crea otra.
 */
export class UpdateSavedView {
  constructor(
    private readonly transactions: TransactionManager,
    private readonly views: SavedViewRepository,
    private readonly clock: Clock,
  ) {}

  async execute(
    input: UpdateSavedViewInput,
  ): Promise<Result<SavedView, TicketingError>> {
    return runTransactional<SavedView, TicketingError>(
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

        const r = vista.rewrite({
          name: input.name,
          filters: input.filters,
          now: this.clock.now(),
        });
        if (r.isErr()) return err(r.error);

        if (
          await this.views.existsName(
            input.tenantId,
            vista.scopeKey,
            vista.nameKey,
            vista.id,
          )
        ) {
          return err(new DuplicateSavedViewNameError());
        }
        await this.views.update(vista);
        return ok(vista);
      },
    );
  }
}
