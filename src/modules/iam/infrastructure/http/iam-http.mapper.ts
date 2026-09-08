import { HttpException, HttpStatus } from '@nestjs/common';
import { IamError } from '../../domain/errors';

/**
 * Traduce un error de dominio (ADR-0005) a una respuesta HTTP en formato
 * `application/problem+json` (RFC 7807).
 *
 * El mapeo vive acá, en el borde: el dominio no sabe qué es un 409. Y el `code`
 * estable viaja en el cuerpo, de modo que el cliente pueda ramificar por él en
 * vez de parsear mensajes.
 */
const STATUS_BY_CODE: Record<string, HttpStatus> = {
  'iam.invalid_email': HttpStatus.BAD_REQUEST,
  'iam.weak_password': HttpStatus.BAD_REQUEST,
  'iam.invalid_organization_name': HttpStatus.BAD_REQUEST,
  'iam.organization_name_taken': HttpStatus.CONFLICT,
  'iam.invalid_credentials': HttpStatus.UNAUTHORIZED,
  'iam.refresh_token_invalid': HttpStatus.UNAUTHORIZED,
  'iam.refresh_token_reuse': HttpStatus.UNAUTHORIZED,
};

export const toHttpException = (error: IamError): HttpException => {
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
