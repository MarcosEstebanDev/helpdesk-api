import { HttpException, HttpStatus } from '@nestjs/common';
import { TicketingError } from '../../domain/errors';

/**
 * Traduce un error de dominio (ADR-0005) a `application/problem+json` (RFC 7807),
 * igual que hace `iam`. El mapeo vive en el borde porque el dominio no sabe qué
 * es un 409.
 *
 * La elección de 409 para las transiciones inválidas y para el ticket cerrado es
 * deliberada: la petición está bien formada (un 400 diría lo contrario) y el
 * usuario tiene permiso (no es un 403); lo que pasa es que CHOCA con el estado
 * actual del recurso, que es exactamente lo que significa Conflict.
 */
const STATUS_BY_CODE: Record<string, HttpStatus> = {
  'ticketing.invalid_subject': HttpStatus.BAD_REQUEST,
  'ticketing.invalid_description': HttpStatus.BAD_REQUEST,
  'ticketing.empty_comment': HttpStatus.BAD_REQUEST,
  'ticketing.internal_note_forbidden': HttpStatus.FORBIDDEN,
  'ticketing.invalid_sla_target': HttpStatus.BAD_REQUEST,
  'ticketing.ticket_not_found': HttpStatus.NOT_FOUND,
  'ticketing.assignee_not_found': HttpStatus.NOT_FOUND,
  'ticketing.invalid_transition': HttpStatus.CONFLICT,
  'ticketing.ticket_closed': HttpStatus.CONFLICT,
  'ticketing.invalid_canned_response': HttpStatus.BAD_REQUEST,
  'ticketing.canned_response_not_found': HttpStatus.NOT_FOUND,
  'ticketing.duplicate_canned_response_title': HttpStatus.CONFLICT,
  'ticketing.invalid_tag': HttpStatus.BAD_REQUEST,
  'ticketing.too_many_tags': HttpStatus.BAD_REQUEST,
  'ticketing.tag_not_found': HttpStatus.NOT_FOUND,
  'ticketing.duplicate_tag_name': HttpStatus.CONFLICT,
};

export const toHttpException = (error: TicketingError): HttpException => {
  // Un código sin mapear es un descuido nuestro, no culpa del cliente: 500.
  const status = STATUS_BY_CODE[error.code] ?? HttpStatus.INTERNAL_SERVER_ERROR;

  return new HttpException(
    {
      type: `https://helpdesk.dev/errors/${error.code}`,
      title: error.message,
      status,
      code: error.code,
    },
    status,
  );
};
