import { Result, err, ok } from '../../../../shared-kernel';
import { TooManyTagsError } from '../errors';
import { TagId } from '../ids';
import { MAX_TAGS_PER_TICKET } from './tag.entity';

export interface TagSetDiff {
  /** El conjunto que queda, sin repetidos, en el orden en que se pidió. */
  next: TagId[];
  /** Lo que no estaba, en el orden de `desired`. */
  added: TagId[];
  /** Lo que estaba y ya no, en el orden de `current`. */
  removed: TagId[];
}

/**
 * Reglas del conjunto de etiquetas de un ticket (ADR-0031), puras: deduplica,
 * aplica el máximo y dice qué cambió. Las etiquetas no son estado del agregado
 * `Ticket` —viven en su propia tabla—, pero estas reglas sí son de dominio y no
 * deben quedar repartidas en el caso de uso.
 */
export const diffTagSets = (
  current: TagId[],
  desired: TagId[],
): Result<TagSetDiff, TooManyTagsError> => {
  const next = [...new Set(desired)];
  if (next.length > MAX_TAGS_PER_TICKET) return err(new TooManyTagsError());

  const antes = new Set(current);
  const despues = new Set(next);
  return ok({
    next,
    added: next.filter((id) => !antes.has(id)),
    removed: current.filter((id) => !despues.has(id)),
  });
};
