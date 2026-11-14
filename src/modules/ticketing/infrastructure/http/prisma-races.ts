import { Prisma } from '@prisma/client';
import {
  DuplicateTagNameError,
  TagNotFoundError,
  TicketingError,
} from '../../domain/errors';

/**
 * Traduce a error de dominio las dos carreras de etiquetas que solo detecta la
 * base (ADR-0031). El caso normal lo resuelven los casos de uso antes de
 * escribir; esto es la red para cuando dos personas coinciden en el mismo
 * milisegundo:
 * - P2002 (unicidad): dos crean el mismo nombre a la vez → duplicado (409).
 * - P2003 (FK): un ADMIN borró la etiqueta entre que se validó y se insertó
 *   la relación → "la etiqueta no existe" (404), no un 500.
 * Cualquier otro error devuelve `null`: no se disfraza lo que no se entiende.
 */
export const carreraComoErrorDeEtiqueta = (
  e: unknown,
): TicketingError | null => {
  if (!(e instanceof Prisma.PrismaClientKnownRequestError)) return null;
  if (e.code === 'P2002') return new DuplicateTagNameError();
  if (e.code === 'P2003') return new TagNotFoundError();
  return null;
};
