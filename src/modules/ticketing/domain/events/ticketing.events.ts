import { IntegrationEvent } from '../../../../shared-kernel';
import { TicketPriority, TicketStatus } from '../ticket-status';

/**
 * Eventos de integración del contexto Ticketing (ADR-0018).
 *
 * Son eventos "gordos": el payload lleva el estado relevante EN EL MOMENTO en
 * que ocurrieron. Un consumidor que releyera el ticket vería el estado ACTUAL,
 * que para cuando el job se ejecuta puede ser otro — y entonces reaccionaría a
 * algo que ya no pasó.
 *
 * `version` acompaña a cada evento porque el payload va a cambiar: un consumidor
 * que reciba una versión que no entiende debe poder rechazarla explícitamente en
 * vez de leer campos que ya no significan lo mismo.
 *
 * Todos son inmutables y describen algo YA ocurrido, de ahí el nombre en pasado.
 */

const AGGREGATE_TYPE = 'ticket';

export class TicketCreated implements IntegrationEvent {
  readonly eventName = 'ticket.created';
  readonly aggregateType = AGGREGATE_TYPE;
  readonly version = 1;

  constructor(
    readonly aggregateId: string,
    readonly tenantId: string,
    readonly occurredAt: Date,
    readonly payload: {
      number: number;
      subject: string;
      priority: TicketPriority;
      status: TicketStatus;
      requesterId: string;
    },
  ) {}
}

export class TicketAssigned implements IntegrationEvent {
  readonly eventName = 'ticket.assigned';
  readonly aggregateType = AGGREGATE_TYPE;
  readonly version = 1;

  constructor(
    readonly aggregateId: string,
    readonly tenantId: string,
    readonly occurredAt: Date,
    readonly payload: { assigneeId: string; status: TicketStatus },
  ) {}
}

export class TicketUnassigned implements IntegrationEvent {
  readonly eventName = 'ticket.unassigned';
  readonly aggregateType = AGGREGATE_TYPE;
  readonly version = 1;

  constructor(
    readonly aggregateId: string,
    readonly tenantId: string,
    readonly occurredAt: Date,
    readonly payload: { status: TicketStatus },
  ) {}
}

export class TicketStatusChanged implements IntegrationEvent {
  readonly eventName = 'ticket.status_changed';
  readonly aggregateType = AGGREGATE_TYPE;
  readonly version = 1;

  constructor(
    readonly aggregateId: string,
    readonly tenantId: string,
    readonly occurredAt: Date,
    readonly payload: {
      from: TicketStatus;
      to: TicketStatus;
      assigneeId: string | null;
    },
  ) {}
}

/**
 * v2: añade `authorRole` (ADR-0020).
 *
 * El motor de SLA necesita saber si quien comentó responde EN NOMBRE de la
 * organización o es el propio cliente. Viaja en el evento en vez de consultarse
 * después porque el rol de una persona cambia con el tiempo, y lo que importa es
 * cuál tenía AL COMENTAR — el mismo razonamiento que justifica los eventos
 * gordos del ADR-0018. Consultarlo más tarde daría el rol actual, que puede ser
 * otro, y reprocesar el evento daría un resultado distinto.
 */
export class CommentAdded implements IntegrationEvent {
  readonly eventName = 'comment.added';
  readonly aggregateType = AGGREGATE_TYPE;
  readonly version = 2;

  constructor(
    readonly aggregateId: string,
    readonly tenantId: string,
    readonly occurredAt: Date,
    readonly payload: {
      commentId: string;
      authorId: string;
      authorRole: string;
    },
  ) {}
}

/** El reloj de un SLA venció sin pararse (ADR-0021). */
export class SlaBreached implements IntegrationEvent {
  readonly eventName = 'sla.breached';
  readonly aggregateType = AGGREGATE_TYPE;
  readonly version = 1;

  constructor(
    readonly aggregateId: string,
    readonly tenantId: string,
    readonly occurredAt: Date,
    readonly payload: {
      timerId: string;
      kind: string;
      dueAt: string;
      assigneeId: string | null;
      priority: TicketPriority;
    },
  ) {}
}

export type TicketingEvent =
  | TicketCreated
  | TicketAssigned
  | TicketUnassigned
  | TicketStatusChanged
  | CommentAdded
  | SlaBreached;
