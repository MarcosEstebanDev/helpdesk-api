import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength } from 'class-validator';
import { Trim } from './transforms';
import {
  CANNED_BODY_MAX,
  CANNED_TITLE_MAX,
} from '../../../domain/canned-response/canned-response.entity';

/**
 * Alta o reemplazo de una respuesta predefinida (ADR-0030).
 *
 * `class-validator` mira solo la FORMA (texto, largo máximo). Que las variables
 * sean conocidas y que no quede una llave suelta es regla de negocio: vive en
 * el dominio, y el 400 que devuelve dice exactamente qué fragmento falla.
 */
export class CannedResponseInputDto {
  @ApiProperty({ maxLength: CANNED_TITLE_MAX, example: 'Saludo inicial' })
  @IsString()
  @Trim()
  @MaxLength(CANNED_TITLE_MAX)
  title!: string;

  @ApiProperty({
    maxLength: CANNED_BODY_MAX,
    description:
      'Texto. Variables: {{ticket.numero}}, {{ticket.asunto}}, {{cliente.email}}, {{agente.email}}.',
    example: 'Hola! Ya estamos revisando el ticket {{ticket.numero}}.',
  })
  @IsString()
  @Trim()
  @MaxLength(CANNED_BODY_MAX)
  body!: string;
}

export class CannedResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() title!: string;
  @ApiProperty() body!: string;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
}

/** Envoltorio `{ items }`: sumar `nextCursor` mañana no rompe a nadie. */
export class CannedResponseListDto {
  @ApiProperty({ type: [CannedResponseDto] }) items!: CannedResponseDto[];
}
