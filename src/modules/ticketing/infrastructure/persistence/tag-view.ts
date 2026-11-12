import type { Prisma } from '@prisma/client';
import { TagColor, isTagColor } from '../../domain/tag/tag.entity';

/** Etiqueta tal como se muestra (ADR-0031). */
export interface TagView {
  id: string;
  name: string;
  color: TagColor;
}

/** Qué se lee de `ticket_tags` para pintar las etiquetas de un ticket. */
export const TAG_SELECT = {
  select: {
    tag: { select: { id: true, name: true, nameKey: true, color: true } },
  },
} satisfies Prisma.TicketTagFindManyArgs;

/**
 * La forma de cada fila SE DERIVA del select: si mañana se quita `nameKey`,
 * esto deja de compilar en vez de reventar en `localeCompare` en ejecución.
 */
export type FilaDeEtiqueta = Prisma.TicketTagGetPayload<typeof TAG_SELECT>;

/**
 * Filas de `ticket_tags` → vistas ordenadas por nombre. Un color fuera de la
 * paleta solo puede venir de un UPDATE a mano: se pinta gris, igual que hace
 * el repositorio del catálogo, en vez de mandarle al front algo que no conoce.
 */
export const aVistasDeEtiquetas = (filas: FilaDeEtiqueta[]): TagView[] =>
  filas
    .map((f) => f.tag)
    .sort((a, b) => a.nameKey.localeCompare(b.nameKey))
    .map(({ id, name, color }) => ({
      id,
      name,
      color: isTagColor(color) ? color : 'gray',
    }));
