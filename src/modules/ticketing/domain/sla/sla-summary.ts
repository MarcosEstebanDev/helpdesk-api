import { TicketStatus, isTerminal } from '../ticket-status';

/** Lo que la bandeja muestra del SLA de un ticket: el reloj que más apura. */
export type SlaSummary =
  | { state: 'none' }
  | { state: 'paused' }
  | { state: 'running'; dueAt: Date }
  | { state: 'breached'; since: Date };

interface RelojLeido {
  dueAt: Date;
  stoppedAt: Date | null;
  breachedAt: Date | null;
  pausedAt: Date | null;
}

/**
 * Resume los relojes de un ticket en UNA cosa para la bandeja (UX, 2026-11-13).
 *
 * Gana el incumplido (el más viejo); si no, el vencimiento más próximo de los
 * que corren; si no, "en pausa". Un reloj que ya pasó su hora pero el barrido
 * todavía no marcó cuenta como incumplido desde su vencimiento: la pantalla no
 * dice "vence en -5 min". Un ticket resuelto o cerrado no muestra SLA: lo que
 * importa en la bandeja es lo que todavía se puede salvar.
 */
export const summarizeSla = (
  status: TicketStatus,
  timers: readonly RelojLeido[],
  now: Date,
): SlaSummary => {
  if (status === 'RESOLVED' || isTerminal(status)) return { state: 'none' };

  const abiertos = timers.filter((t) => t.stoppedAt === null);
  const incumplidos = abiertos
    .map(
      (t) =>
        t.breachedAt ??
        (t.pausedAt === null && t.dueAt.getTime() <= now.getTime()
          ? t.dueAt
          : null),
    )
    .filter((d): d is Date => d !== null)
    .sort((a, b) => a.getTime() - b.getTime());
  if (incumplidos.length > 0)
    return { state: 'breached', since: incumplidos[0] };

  const corriendo = abiertos
    .filter((t) => t.breachedAt === null && t.pausedAt === null)
    .map((t) => t.dueAt)
    .sort((a, b) => a.getTime() - b.getTime());
  if (corriendo.length > 0) return { state: 'running', dueAt: corriendo[0] };

  if (abiertos.some((t) => t.pausedAt !== null && t.breachedAt === null)) {
    return { state: 'paused' };
  }
  return { state: 'none' };
};
