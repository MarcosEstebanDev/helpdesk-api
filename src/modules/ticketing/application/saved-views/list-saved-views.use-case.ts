import { TenantId, UserId } from '../../domain/ids';
import { SavedViewRepository } from '../../domain/ports/saved-view.repository';
import { SavedView } from '../../domain/saved-view/saved-view.entity';

/** Las vistas que ve quien pide: compartidas primero, después las suyas (ADR-0033). */
export class ListSavedViews {
  constructor(private readonly views: SavedViewRepository) {}

  execute(input: {
    tenantId: TenantId;
    actorId: UserId;
  }): Promise<SavedView[]> {
    return this.views.listVisible(input.tenantId, input.actorId);
  }
}
