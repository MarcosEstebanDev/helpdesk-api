import { AggregateRoot, Result, err, ok } from '../../../../shared-kernel';
import {
  InvalidTicketDescriptionError,
  InvalidTicketSubjectError,
  InvalidTicketTransitionError,
  TicketClosedError,
  TicketingError,
} from '../errors';
import { TenantId, TicketId, UserId } from '../ids';
import {
  TicketPriority,
  TicketStatus,
  canTransition,
  isTerminal,
} from '../ticket-status';

const SUBJECT_MAX = 200;
const DESCRIPTION_MAX = 10_000;

interface TicketProps {
  tenantId: TenantId;
  /** Número visible correlativo POR tenant (#1042). Ver ADR-0017. */
  number: number;
  subject: string;
  description: string;
  status: TicketStatus;
  priority: TicketPriority;
  requesterId: UserId;
  assigneeId: UserId | null;
  createdAt: Date;
  updatedAt: Date;
  resolvedAt: Date | null;
  closedAt: Date | null;
}

/**
 * Raíz del agregado Ticket (ADR-0015).
 *
 * Toda mutación pasa por un método que devuelve `Result`: la entidad es la que
 * decide si el cambio es legal, y el caso de uso solo orquesta. Esa es la razón
 * de que no haya setters públicos — con un `ticket.status = 'CLOSED'` la máquina
 * de estados sería decorativa.
 */
export class Ticket extends AggregateRoot<TicketId> {
  private constructor(
    id: TicketId,
    private readonly props: TicketProps,
  ) {
    super(id);
  }

  get tenantId(): TenantId {
    return this.props.tenantId;
  }

  get number(): number {
    return this.props.number;
  }

  get subject(): string {
    return this.props.subject;
  }

  get description(): string {
    return this.props.description;
  }

  get status(): TicketStatus {
    return this.props.status;
  }

  get priority(): TicketPriority {
    return this.props.priority;
  }

  get requesterId(): UserId {
    return this.props.requesterId;
  }

  get assigneeId(): UserId | null {
    return this.props.assigneeId;
  }

  get createdAt(): Date {
    return this.props.createdAt;
  }

  get updatedAt(): Date {
    return this.props.updatedAt;
  }

  get resolvedAt(): Date | null {
    return this.props.resolvedAt;
  }

  get closedAt(): Date | null {
    return this.props.closedAt;
  }

  // ---------------------------------------------------------------- comandos

  /**
   * Cambia el estado si la transición está permitida.
   *
   * Es el ÚNICO camino para tocar `status`: `resolve()` o `close()` delegan aquí
   * en vez de tener cada uno su propia comprobación, para que no puedan
   * divergir de la tabla del ADR-0015.
   */
  changeStatus(next: TicketStatus, now: Date): Result<void, TicketingError> {
    const current = this.props.status;

    if (current === next) {
      // Idempotente: pedir el estado en el que ya está no es un error de negocio,
      // pero tampoco debe tocar `updatedAt` ni los timestamps del ciclo de vida.
      return ok(undefined);
    }

    if (!canTransition(current, next)) {
      return err(new InvalidTicketTransitionError(current, next));
    }

    this.props.status = next;
    this.applyLifecycleTimestamps(next, now);
    this.touch(now);
    return ok(undefined);
  }

  /**
   * Asigna el ticket a un agente. No cambia el estado: tomar un ticket y
   * empezar a trabajarlo son dos decisiones distintas, y mezclarlas impediría
   * repartir una cola de tickets sin marcarlos todos como en curso.
   */
  assignTo(assigneeId: UserId, now: Date): Result<void, TicketingError> {
    if (isTerminal(this.props.status)) {
      return err(new TicketClosedError());
    }
    this.props.assigneeId = assigneeId;
    this.touch(now);
    return ok(undefined);
  }

  unassign(now: Date): Result<void, TicketingError> {
    if (isTerminal(this.props.status)) {
      return err(new TicketClosedError());
    }
    this.props.assigneeId = null;
    this.touch(now);
    return ok(undefined);
  }

  /** ¿Admite todavía comentarios? Un ticket cerrado no. */
  acceptsComments(): boolean {
    return !isTerminal(this.props.status);
  }

  /**
   * Los timestamps del ciclo de vida se DERIVAN del estado, nunca se reciben de
   * fuera: así es imposible que exista un ticket RESOLVED sin `resolvedAt`, o
   * uno OPEN que conserve la fecha en que se resolvió una vez.
   *
   * Nótese que cerrar NO toca `resolvedAt`: un ticket cerrado sigue habiendo
   * sido resuelto en su momento, y la fase 6 necesitará ese instante para medir
   * el cumplimiento del SLA. Reabrir sí lo limpia, porque a partir de ahí el
   * ticket vuelve a estar pendiente.
   */
  private applyLifecycleTimestamps(next: TicketStatus, now: Date): void {
    switch (next) {
      case 'RESOLVED':
        this.props.resolvedAt = now;
        break;
      case 'CLOSED':
        this.props.closedAt = now;
        break;
      case 'OPEN':
      case 'IN_PROGRESS':
        this.props.resolvedAt = null;
        this.props.closedAt = null;
        break;
    }
  }

  private touch(now: Date): void {
    this.props.updatedAt = now;
  }

  // ------------------------------------------------------------ constructores

  /**
   * Alta de un ticket. Valida la forma del asunto y la descripción aquí —y no
   * solo en el DTO— porque la fase 5 creará tickets desde el email entrante, que
   * no pasa por ningún DTO de HTTP.
   */
  static open(input: {
    id: TicketId;
    tenantId: TenantId;
    number: number;
    subject: string;
    description: string;
    priority: TicketPriority;
    requesterId: UserId;
    now: Date;
  }): Result<Ticket, TicketingError> {
    const subject = input.subject.trim();
    if (subject.length === 0 || subject.length > SUBJECT_MAX) {
      return err(new InvalidTicketSubjectError());
    }

    const description = input.description.trim();
    if (description.length === 0 || description.length > DESCRIPTION_MAX) {
      return err(new InvalidTicketDescriptionError());
    }

    return ok(
      new Ticket(input.id, {
        tenantId: input.tenantId,
        number: input.number,
        subject,
        description,
        status: 'OPEN',
        priority: input.priority,
        requesterId: input.requesterId,
        assigneeId: null,
        createdAt: input.now,
        updatedAt: input.now,
        resolvedAt: null,
        closedAt: null,
      }),
    );
  }

  static rehydrate(input: { id: TicketId } & TicketProps): Ticket {
    const { id, ...props } = input;
    return new Ticket(id, { ...props });
  }
}
