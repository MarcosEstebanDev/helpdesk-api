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
 * Solo el equipo escribe notas internas (ADR-0028). Es un 403 y no un 400: la
 * petición está bien formada, lo que falta es el rango.
 */
export class InternalNoteForbiddenError extends DomainError {
  readonly code = 'ticketing.internal_note_forbidden';
  constructor() {
    super('Solo el equipo de soporte puede escribir notas internas.');
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

/**
 * Horario laboral imposible: sin días hábiles, cierre antes de la apertura,
 * una hora que no existe o una zona horaria desconocida. El detalle viaja en el
 * error por la misma razón que en el SLA: el ADMIN está editando un formulario.
 */
export class InvalidBusinessHoursError extends DomainError {
  readonly code = 'ticketing.invalid_business_hours';
  constructor(detail: string) {
    super(detail);
  }
}

/**
 * El servicio de IA no está disponible ahora (caído, timeout, sobrecargado).
 * Es TRANSITORIO: el consumidor lo lanza para que la cola reintente con backoff.
 */
export class TriageUnavailableError extends DomainError {
  readonly code = 'ticketing.triage_unavailable';
  constructor(detail: string) {
    super(detail);
  }
}

/**
 * El servicio de IA rechazó la petición o devolvió algo que no aceptamos.
 * Es PERMANENTE: reintentar el mismo texto daría lo mismo, va a la DLQ.
 */
export class TriageRejectedError extends DomainError {
  readonly code = 'ticketing.triage_rejected';
  constructor(detail: string) {
    super(detail);
  }
}

/**
 * La respuesta predefinida no es válida (ADR-0030). El mensaje dice QUÉ falla
 * —y si es una variable, cuál—, porque el administrador está editando un
 * formulario y tiene que poder corregirlo sin adivinar.
 */
export class InvalidCannedResponseError extends DomainError {
  readonly code = 'ticketing.invalid_canned_response';
  constructor(detail: string) {
    super(detail);
  }
}

export class CannedResponseNotFoundError extends DomainError {
  readonly code = 'ticketing.canned_response_not_found';
  constructor() {
    super('La respuesta predefinida no existe.');
  }
}

/** Dos respuestas con el mismo título (sin distinguir mayúsculas) confunden al elegir. */
export class DuplicateCannedResponseTitleError extends DomainError {
  readonly code = 'ticketing.duplicate_canned_response_title';
  constructor() {
    super('Ya hay una respuesta predefinida con ese título.');
  }
}

/** Nombre o color de etiqueta inválido (ADR-0031). El mensaje dice cuál. */
export class InvalidTagError extends DomainError {
  readonly code = 'ticketing.invalid_tag';
  constructor(detail: string) {
    super(detail);
  }
}

export class TagNotFoundError extends DomainError {
  readonly code = 'ticketing.tag_not_found';
  constructor() {
    super('La etiqueta no existe.');
  }
}

export class DuplicateTagNameError extends DomainError {
  readonly code = 'ticketing.duplicate_tag_name';
  constructor() {
    super('Ya hay una etiqueta con ese nombre.');
  }
}

export class TooManyTagsError extends DomainError {
  readonly code = 'ticketing.too_many_tags';
  constructor() {
    super('Un ticket puede tener como mucho 10 etiquetas.');
  }
}

/** Nombre o filtros de una vista guardada inválidos (ADR-0033). Dice cuál. */
export class InvalidSavedViewError extends DomainError {
  readonly code = 'ticketing.invalid_saved_view';
  constructor(detail: string) {
    super(detail);
  }
}

/** No existe, o es la vista personal de otra persona (invisible: mismo 404). */
export class SavedViewNotFoundError extends DomainError {
  readonly code = 'ticketing.saved_view_not_found';
  constructor() {
    super('La vista no existe.');
  }
}

export class DuplicateSavedViewNameError extends DomainError {
  readonly code = 'ticketing.duplicate_saved_view_name';
  constructor() {
    super('Ya hay una vista con ese nombre.');
  }
}

/** Las vistas compartidas solo las crea, edita y borra un ADMIN. */
export class SavedViewForbiddenError extends DomainError {
  readonly code = 'ticketing.saved_view_forbidden';
  constructor() {
    super('Solo un administrador puede crear o cambiar vistas compartidas.');
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
  | InternalNoteForbiddenError
  | InvalidSlaTargetError
  | InvalidBusinessHoursError
  | TriageUnavailableError
  | TriageRejectedError
  | InvalidCannedResponseError
  | CannedResponseNotFoundError
  | DuplicateCannedResponseTitleError
  | InvalidTagError
  | TagNotFoundError
  | DuplicateTagNameError
  | TooManyTagsError
  | InvalidSavedViewError
  | SavedViewNotFoundError
  | DuplicateSavedViewNameError
  | SavedViewForbiddenError;
