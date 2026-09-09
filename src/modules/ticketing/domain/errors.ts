import { DomainError } from '../../../shared-kernel';
import { TicketStatus } from './ticket-status';

/**
 * Errores de dominio del contexto Ticketing (errores-as-values, ADR-0005).
 * El `code` es estable y el borde HTTP lo traduce a un status.
 */
export class InvalidTicketSubjectError extends DomainError {
  readonly code = 'ticketing.invalid_subject';
  constructor() {
    super('El asunto del ticket no puede estar vacío.');
  }
}

export class InvalidTicketDescriptionError extends DomainError {
  readonly code = 'ticketing.invalid_description';
  constructor() {
    super('La descripción del ticket no puede estar vacía.');
  }
}

export class TicketNotFoundError extends DomainError {
  readonly code = 'ticketing.ticket_not_found';
  constructor() {
    super('El ticket no existe.');
  }
}

/**
 * La transición pedida no está en la tabla del ADR-0015. El mensaje dice el
 * origen y el destino porque es información que el cliente ya conoce (acaba de
 * pedirla) y le ahorra adivinar por qué le rechazaron el cambio.
 */
export class InvalidTicketTransitionError extends DomainError {
  readonly code = 'ticketing.invalid_transition';
  constructor(
    readonly from: TicketStatus,
    readonly to: TicketStatus,
  ) {
    super(`No se puede pasar un ticket de ${from} a ${to}.`);
  }
}

export class TicketClosedError extends DomainError {
  readonly code = 'ticketing.ticket_closed';
  constructor() {
    super('El ticket está cerrado y ya no admite cambios.');
  }
}

/** El usuario al que se quiere asignar no pertenece a esta organización. */
export class AssigneeNotFoundError extends DomainError {
  readonly code = 'ticketing.assignee_not_found';
  constructor() {
    super('El usuario indicado no pertenece a esta organización.');
  }
}

export class EmptyCommentError extends DomainError {
  readonly code = 'ticketing.empty_comment';
  constructor() {
    super('El comentario no puede estar vacío.');
  }
}

/**
 * El objetivo de SLA que intenta configurar la organización no es aplicable.
 *
 * Cubre tanto los valores imposibles (cero, negativos, fracciones de minuto,
 * plazos de más de un año) como el caso interesante: prometer resolver ANTES de
 * responder. Los dos relojes son independientes y el motor lo aceptaría sin
 * rechistar, así que la incoherencia hay que atajarla aquí; el mensaje concreto
 * viaja en el error porque el administrador está editando un formulario y
 * necesita saber cuál de las dos cifras le rechazaron.
 */
export class InvalidSlaTargetError extends DomainError {
  readonly code = 'ticketing.invalid_sla_target';
  constructor(detail: string) {
    super(detail);
  }
}

export type TicketingError =
  | InvalidTicketSubjectError
  | InvalidTicketDescriptionError
  | TicketNotFoundError
  | InvalidTicketTransitionError
  | TicketClosedError
  | AssigneeNotFoundError
  | EmptyCommentError
  | InvalidSlaTargetError;
