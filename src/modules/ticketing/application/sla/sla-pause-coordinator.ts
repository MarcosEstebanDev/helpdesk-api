import { TenantId, TicketId } from '../../domain/ids';
import { SlaTimerRepository } from '../../domain/ports/sla.repository';
import { CALENDAR_24_7 } from '../../domain/sla/sla-calendar';
import { TicketStatus } from '../../domain/ticket-status';

export type SlaPauseOutcome = 'paused' | 'resumed' | 'none';

/**
 * Pausa y reanuda el reloj de RESOLUCIÓN cuando el ticket entra en la espera
 * del cliente o sale de ella (ADR-0029).
 *
 * **Es síncrono a propósito**: lo llaman `ChangeTicketStatus` y `AddComment`
 * DENTRO de la transacción del cambio de estado, con el mismo `now`. Es la única
 * excepción al patrón "los relojes los mueve el consumidor del outbox"
 * (ADR-0021), y la razón es que pausar no tolera retraso:
 *
 * - En diferido, espera → retomar → espera antes de que el worker procese hacía
 *   que el tramo trabajado contara como pausa.
 * - Una pausa procesada tarde llegaba después de que el barrido marcara un
 *   incumplimiento, que es irreversible.
 *
 * Arrancar y parar sí toleran retraso (se fechan con `occurredAt` y nadie decide
 * nada con el reloj mientras tanto), así que siguen en el consumidor; en
 * particular, resolver desde la espera NO pasa por aquí: lo para `StopSlaTimer`,
 * que ya sabe parar un reloj pausado.
 *
 * Que no haya reloj abierto, o que la escritura pierda la carrera contra el
 * barrido, no es un error: se devuelve `none` y el cambio de estado sigue.
 */
export class SlaPauseCoordinator {
  constructor(private readonly timers: SlaTimerRepository) {}

  async onStatusChange(input: {
    tenantId: TenantId;
    ticketId: TicketId;
    from: TicketStatus;
    to: TicketStatus;
    now: Date;
  }): Promise<SlaPauseOutcome> {
    const pausar = input.to === 'WAITING_ON_CUSTOMER';
    const reanudar =
      input.from === 'WAITING_ON_CUSTOMER' && input.to === 'IN_PROGRESS';
    if (!pausar && !reanudar) return 'none';

    const timer = await this.timers.findOpen(
      input.tenantId,
      input.ticketId,
      'RESOLUTION',
    );
    if (timer === null) return 'none';

    if (pausar) {
      if (!timer.pause(input.now)) return 'none';
      return (await this.timers.transition(timer, 'running'))
        ? 'paused'
        : 'none';
    }

    // Mismo calendario con el que arrancó el reloj (hoy siempre 24/7).
    if (!timer.resume(input.now, CALENDAR_24_7)) return 'none';
    return (await this.timers.transition(timer, 'paused')) ? 'resumed' : 'none';
  }
}
