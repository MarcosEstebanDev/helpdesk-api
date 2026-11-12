import { TenantId } from '../../domain/ids';
import { TagRepository } from '../../domain/ports/tag.repository';
import { Tag } from '../../domain/tag/tag.entity';

/** El catálogo de la organización, por nombre (ADR-0031). */
export class ListTags {
  constructor(private readonly tags: TagRepository) {}

  execute(input: { tenantId: TenantId }): Promise<Tag[]> {
    return this.tags.list(input.tenantId);
  }
}
