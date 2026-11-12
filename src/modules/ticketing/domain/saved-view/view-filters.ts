import { Result, err, ok } from '../../../../shared-kernel';
import { InvalidSavedViewError } from '../errors';
import { MAX_TAGS_PER_TICKET } from '../tag/tag.entity';
import { TicketStatus, isTicketStatus } from '../ticket-status';

/**
 * Filtros de una vista guardada, versión 1 (ADR-0033).
 *
 * Se guardan como JSON y se validan AL GUARDAR, con una lista cerrada de
 * claves: una vista con una clave que nadie entiende sería una vista que dice
 * filtrar algo y no lo hace. `version` es la puerta para cambiar la forma más
 * adelante: una v2 se traduciría acá, no en cada lector.
 */
export interface ViewFilters {
  version: 1;
  status?: TicketStatus;
  /** "Asignados a mí": se guarda "yo", no un id (decisión 11). */
  assignee?: 'me';
  /** Al menos una de estas etiquetas (decisión 12). */
  tagIds?: string[];
  q?: string;
  aiSuggestsHigher?: true;
}

const CLAVES = new Set([
  'version',
  'status',
  'assignee',
  'tagIds',
  'q',
  'aiSuggestsHigher',
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const Q_MAX = 200;

const invalido = (campo: string, detalle: string) =>
  err(new InvalidSavedViewError(`filters.${campo}: ${detalle}`));

export const parseViewFilters = (
  raw: unknown,
): Result<ViewFilters, InvalidSavedViewError> => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return invalido('', 'tiene que ser un objeto.');
  }
  const datos = raw as Record<string, unknown>;

  for (const clave of Object.keys(datos)) {
    if (!CLAVES.has(clave)) return invalido(clave, 'no es un filtro conocido.');
  }
  if (datos.version !== 1) {
    return invalido('version', 'solo se admite la versión 1.');
  }

  const filtros: ViewFilters = { version: 1 };

  if (datos.status !== undefined) {
    if (typeof datos.status !== 'string' || !isTicketStatus(datos.status)) {
      return invalido('status', 'no es un estado de ticket.');
    }
    filtros.status = datos.status;
  }

  if (datos.assignee !== undefined) {
    if (datos.assignee !== 'me') {
      return invalido(
        'assignee',
        'solo admite "me" (asignados a quien abre la vista).',
      );
    }
    filtros.assignee = 'me';
  }

  if (datos.tagIds !== undefined) {
    if (!Array.isArray(datos.tagIds))
      return invalido('tagIds', 'tiene que ser una lista.');
    const ids = datos.tagIds.map((v) =>
      typeof v === 'string' ? v.toLowerCase() : v,
    );
    if (!ids.every((v): v is string => typeof v === 'string' && UUID.test(v))) {
      return invalido('tagIds', 'cada etiqueta tiene que ser un uuid.');
    }
    const unicos = [...new Set(ids)];
    if (unicos.length > MAX_TAGS_PER_TICKET) {
      return invalido('tagIds', `como mucho ${MAX_TAGS_PER_TICKET} etiquetas.`);
    }
    if (unicos.length > 0) filtros.tagIds = unicos;
  }

  if (datos.q !== undefined) {
    if (typeof datos.q !== 'string')
      return invalido('q', 'tiene que ser texto.');
    const q = datos.q.trim();
    if (q.length > Q_MAX)
      return invalido('q', `como mucho ${Q_MAX} caracteres.`);
    if (q !== '') filtros.q = q;
  }

  if (datos.aiSuggestsHigher !== undefined) {
    if (datos.aiSuggestsHigher !== true) {
      return invalido('aiSuggestsHigher', 'solo admite true (o no ponerlo).');
    }
    filtros.aiSuggestsHigher = true;
  }

  return ok(filtros);
};
