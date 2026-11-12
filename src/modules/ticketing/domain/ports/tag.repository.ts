import { TagId, TenantId } from '../ids';
import { Tag } from '../tag/tag.entity';

/** Catálogo de etiquetas de la organización (ADR-0031). */
export interface TagRepository {
  /** Todas, ordenadas por nombre (`name_key`). */
  list(tenantId: TenantId): Promise<Tag[]>;

  findById(tenantId: TenantId, id: TagId): Promise<Tag | null>;

  /** Las que existan de esos ids; las que no, simplemente no vienen. */
  findByIds(tenantId: TenantId, ids: TagId[]): Promise<Tag[]>;

  /** ¿Otra etiqueta usa ese nombre? `exceptId` excluye a la propia. */
  existsNameKey(
    tenantId: TenantId,
    nameKey: string,
    exceptId?: TagId,
  ): Promise<boolean>;

  insert(tag: Tag): Promise<void>;

  update(tag: Tag): Promise<void>;

  /** La quita también de todos los tickets (cascada). Dice si existía. */
  remove(tenantId: TenantId, id: TagId): Promise<boolean>;
}

export const TAG_REPOSITORY = Symbol('ticketing.TagRepository');
