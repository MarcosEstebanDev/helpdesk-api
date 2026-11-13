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
 * **Regla: lo que todavía se puede salvar** (decidida con el usuario el
 * 2026-11-13, "opción B", como Zendesk). Primero el vencimiento más próximo de
 * los que corren; si no, "en pausa"; y solo si no queda ningún reloj vivo, el
 * incumplimiento más viejo.
 *
 * Por qué no gana el incumplido: un reloj incumplido NUNCA se para (`stop()`
 * sale temprano si no está abierto), así que el dato no dice si después alguien
 * respondió. Con "gana el incumplido", una primera respuesta vencida dejaba la
 * fila en rojo hasta resolver el ticket, ya respondido y esperando al cliente.
 * El costo aceptado: una respuesta vencida y AÚN sin responder, con la
 * resolución corriendo, se ve como "vence en…" en la bandeja (el incumplimiento
 * sigue a la vista en el detalle).
 *
 * Un reloj que pasó su hora sin que el barrido lo marcara cuenta igual que un
 * incumplido, desde su vencimiento: así la fila no cambia cuando pasa el
 * barrido, y la pantalla nunca dice "vence en -5 min". Un ticket resuelto o
 * cerrado no muestra SLA.
 */
export const summarizeSla = (
  status: TicketStatus,
  timers: readonly RelojLeido[],
  now: Date,
): SlaSummary => {
  if (status === 'RESOLVED' || isTerminal(status)) return { state: 'none' };

  const abiertos = timers.filter((t) => t.stoppedAt === null);
  /** Desde cuándo está incumplido, marcado o no por el barrido; o `null`. */
  const incumplidoDesde = (t: RelojLeido): Date | null =>
    t.breachedAt ??
    (t.pausedAt === null && t.dueAt.getTime() <= now.getTime()
      ? t.dueAt
      : null);
  const vivos = abiertos.filter((t) => incumplidoDesde(t) === null);

  const corriendo = vivos
    .filter((t) => t.pausedAt === null)
    .map((t) => t.dueAt)
    .sort((a, b) => a.getTime() - b.getTime());
  if (corriendo.length > 0) return { state: 'running', dueAt: corriendo[0] };

  if (vivos.some((t) => t.pausedAt !== null)) return { state: 'paused' };

  const incumplidos = abiertos
    .map(incumplidoDesde)
    .filter((d): d is Date => d !== null)
    .sort((a, b) => a.getTime() - b.getTime());
  if (incumplidos.length > 0)
    return { state: 'breached', since: incumplidos[0] };

  return { state: 'none' };
};
