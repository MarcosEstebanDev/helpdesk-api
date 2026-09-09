import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Max, Min } from 'class-validator';
import { SLA_MAX_MINUTES } from '../../../domain/sla/sla-policy';
import { TICKET_PRIORITIES } from '../../../domain/ticket-status';

/**
 * Objetivo que se quiere fijar para una prioridad.
 *
 * `class-validator` comprueba aquí solo la FORMA de cada número (entero, dentro
 * de rango). La regla que relaciona los dos campos —no puedes prometer resolver
 * antes de responder— se queda en el dominio, en `makeSlaTarget`: es una regla
 * de negocio, y si viviera en el DTO se la saltaría cualquier otra entrada al
 * sistema que no fuera este endpoint.
 */
export class UpdateSlaPolicyDto {
  @ApiProperty({
    minimum: 1,
    maximum: SLA_MAX_MINUTES,
    description: 'Minutos para la primera respuesta de la organización.',
    example: 60,
  })
  @IsInt()
  @Min(1)
  @Max(SLA_MAX_MINUTES)
  responseMinutes!: number;

  @ApiProperty({
    minimum: 1,
    maximum: SLA_MAX_MINUTES,
    description: 'Minutos para dejar el ticket resuelto.',
    example: 480,
  })
  @IsInt()
  @Min(1)
  @Max(SLA_MAX_MINUTES)
  resolutionMinutes!: number;
}

export class EffectiveSlaTargetDto {
  @ApiProperty({ enum: TICKET_PRIORITIES }) priority!: string;
  @ApiProperty() responseMinutes!: number;
  @ApiProperty() resolutionMinutes!: number;
  @ApiProperty({
    enum: ['organization', 'default'],
    description:
      'De dónde sale el objetivo: pactado por la organización o el que trae el producto.',
  })
  source!: string;
}
