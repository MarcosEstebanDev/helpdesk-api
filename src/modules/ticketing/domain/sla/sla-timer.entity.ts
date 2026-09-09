import { Entity } from '../../../../shared-kernel';
import { SlaTimerId, TenantId, TicketId } from '../ids';
import { SlaCalendar } from './sla-calendar';

/**
 * Los dos relojes que corren sobre un ticket (ADR-0020).
 * - `RESPONSE`: hasta la primera respuesta de la organización.
 * - `RESOLUTION`: hasta que el ticket queda resuelto.
 */
export const SLA_KINDS = ['RESPONSE', 'RESOLUTION'] as const;

export type SlaKind = (typeof SLA_KINDS)[number];

export const isSlaKind = (value: string): value is SlaKind =>
  (SLA_KINDS as readonly string[]).includes(value);

interface SlaTimerProps {
  tenantId: TenantId;
  ticketId: TicketId;
  kind: SlaKind;
  startedAt: Date;
  dueAt: Date;
  /** Se cumplió a tiempo (o el ticket dejó de estar pendiente). */
  stoppedAt: Date | null;
  /** Venció sin haberse parado. */
  breachedAt: Date | null;
}

/**
 * Un reloj de SLA.
 *
 * Los tres estados posibles son excluyentes y se derivan, no se guardan como un
 * campo `status`: **corriendo** (ni parado ni incumplido), **parado** (se cumplió)
 * e **incumplido**. Guardar además un `status` permitiría que dijera una cosa y
 * las fechas otra.
 */
export class SlaTimer extends Entity<SlaTimerId> {
  private constructor(
    id: SlaTimerId,
    private readonly props: SlaTimerProps,
  ) {
    super(id);
  }

  get tenantId(): TenantId {
    return this.props.tenantId;
  }

  get ticketId(): TicketId {
    return this.props.ticketId;
  }

  get kind(): SlaKind {
    return this.props.kind;
  }

  get startedAt(): Date {
    return this.props.startedAt;
  }

  get dueAt(): Date {
    return this.props.dueAt;
  }

  get stoppedAt(): Date | null {
    return this.props.stoppedAt;
  }

  get breachedAt(): Date | null {
    return this.props.breachedAt;
  }

  isRunning(): boolean {
    return this.props.stoppedAt === null && this.props.breachedAt === null;
  }

  isBreached(): boolean {
    return this.props.breachedAt !== null;
  }

  /** ¿Ya pasó su hora sin pararse? */
  isOverdue(now: Date): boolean {
    return this.isRunning() && now.getTime() >= this.props.dueAt.getTime();
  }

  /**
   * Para el reloj. Idempotente: un reloj ya parado se queda con su primera
   * fecha, porque lo que interesa es CUÁNDO se cumplió, no la última vez que
   * alguien lo intentó.
   */
  stop(now: Date): void {
    if (!this.isRunning()) return;
    this.props.stoppedAt = now;
  }

  /**
   * Marca el incumplimiento. Un reloj ya parado a tiempo NO puede incumplir
   * después: el barrido puede llegar tarde y encontrarse con que alguien
   * respondió mientras tanto.
   */
  markBreached(now: Date): boolean {
    if (!this.isRunning()) return false;
    this.props.breachedAt = now;
    return true;
  }

  /** Minutos de margen que quedaban al pararlo (negativo si se pasó). */
  remainingMinutesAt(instant: Date): number {
    return Math.round(
      (this.props.dueAt.getTime() - instant.getTime()) / 60_000,
    );
  }

  static start(input: {
    id: SlaTimerId;
    tenantId: TenantId;
    ticketId: TicketId;
    kind: SlaKind;
    minutes: number;
    calendar: SlaCalendar;
    now: Date;
  }): SlaTimer {
    return new SlaTimer(input.id, {
      tenantId: input.tenantId,
      ticketId: input.ticketId,
      kind: input.kind,
      startedAt: input.now,
      // El vencimiento se calcula UNA vez y se persiste, en lugar de derivarlo
      // en cada lectura: si mañana el tenant cambia su política, los relojes ya
      // en marcha conservan el objetivo con el que nacieron. Cambiar las reglas
      // a mitad de partida es justo lo que no debe pasar en un SLA.
      dueAt: input.calendar.dueAt(input.now, input.minutes),
      stoppedAt: null,
      breachedAt: null,
    });
  }

  static rehydrate(input: { id: SlaTimerId } & SlaTimerProps): SlaTimer {
    const { id, ...props } = input;
    return new SlaTimer(id, { ...props });
  }
}
