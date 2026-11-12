import { SavedViewId, TenantId, UserId } from '../ids';
import { SavedView } from '../saved-view/saved-view.entity';

/** Vistas guardadas (ADR-0033). */
export interface SavedViewRepository {
  /** Las compartidas y las de `userId`: compartidas primero, después por nombre. */
  listVisible(tenantId: TenantId, userId: UserId): Promise<SavedView[]>;

  /** Una vista que `userId` puede ver; la personal de otro es `null`. */
  findVisible(
    tenantId: TenantId,
    userId: UserId,
    id: SavedViewId,
  ): Promise<SavedView | null>;

  /** ¿Otra vista del mismo ámbito usa ese nombre? */
  existsName(
    tenantId: TenantId,
    scopeKey: string,
    nameKey: string,
    exceptId?: SavedViewId,
  ): Promise<boolean>;

  insert(view: SavedView): Promise<void>;

  update(view: SavedView): Promise<void>;

  remove(tenantId: TenantId, id: SavedViewId): Promise<boolean>;
}

export const SAVED_VIEW_REPOSITORY = Symbol('ticketing.SavedViewRepository');
