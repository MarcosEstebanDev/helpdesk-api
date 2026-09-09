import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
} from 'class-validator';
import { SLA_KINDS } from '../../../domain/sla/sla-timer.entity';
import {
  TICKET_PRIORITIES,
  TICKET_STATUSES,
} from '../../../domain/ticket-status';
// `import type` obligatorio: con `emitDecoratorMetadata` + `isolatedModules`, un
// tipo usado en una propiedad DECORADA debe importarse así para que el
// transpilador sepa que puede borrarlo en vez de emitirlo como valor.
import type {
  TicketPriority,
  TicketStatus,
} from '../../../domain/ticket-status';

/**
 * DTOs del borde HTTP. Validan FORMA (tipo, longitud, que el valor esté en el
 * enum); las reglas de negocio —qué transiciones son legales, si un ticket
 * cerrado admite comentarios— viven en el dominio. Duplicarlas aquí las
 * desincronizaría en cuanto una de las dos cambiara.
 *
 * Los `@IsIn` sí se derivan de las constantes del dominio, de modo que añadir un
 * estado allí no deja este fichero desfasado.
 */

export class CreateTicketDto {
  @ApiProperty({ example: 'No puedo acceder al panel', maxLength: 200 })
  @IsString()
  @Length(1, 200)
  subject!: string;

  @ApiProperty({ example: 'Al entrar me devuelve un error 500.' })
  @IsString()
  @Length(1, 10_000)
  description!: string;

  @ApiPropertyOptional({ enum: TICKET_PRIORITIES, default: 'NORMAL' })
  @IsOptional()
  @IsIn(TICKET_PRIORITIES)
  priority?: TicketPriority;
}

export class AssignTicketDto {
  @ApiProperty({
    description: 'Usuario de ESTA organización al que se asigna.',
  })
  @IsUUID()
  assigneeId!: string;
}

export class ChangeTicketStatusDto {
  @ApiProperty({
    enum: TICKET_STATUSES,
    description:
      'Estado destino. Solo se aceptan las transiciones del ADR-0015; el resto devuelve 409.',
  })
  @IsIn(TICKET_STATUSES)
  status!: TicketStatus;
}

export class AddCommentDto {
  @ApiProperty({ example: 'Ya lo estamos mirando.' })
  @IsString()
  @Length(1, 10_000)
  body!: string;
}

export class ListTicketsQueryDto {
  @ApiPropertyOptional({ enum: TICKET_STATUSES })
  @IsOptional()
  @IsIn(TICKET_STATUSES)
  status?: TicketStatus;

  @ApiPropertyOptional({ description: 'Filtra por agente asignado.' })
  @IsOptional()
  @IsUUID()
  assigneeId?: string;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  // Los query params llegan como string; sin esta conversión `@IsInt` fallaría
  // siempre. `transform: true` del ValidationPipe global es lo que la ejecuta.
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({
    description:
      'Id del último ticket recibido, para pedir la página siguiente.',
  })
  @IsOptional()
  @IsUUID()
  cursor?: string;
}

// --------------------------------------------------------------- respuestas

export class TicketSummaryDto {
  @ApiProperty() id!: string;
  @ApiProperty({ description: 'Número visible, correlativo por organización.' })
  number!: number;
  @ApiProperty() subject!: string;
  @ApiProperty({ enum: TICKET_STATUSES }) status!: string;
  @ApiProperty({ enum: TICKET_PRIORITIES }) priority!: string;
  @ApiProperty() requesterId!: string;
  @ApiProperty({ nullable: true }) assigneeId!: string | null;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}

export class TicketCommentDto {
  @ApiProperty() id!: string;
  @ApiProperty() authorId!: string;
  @ApiProperty() body!: string;
  @ApiProperty() createdAt!: Date;
}

export class TicketSlaDto {
  @ApiProperty({ enum: SLA_KINDS }) kind!: string;
  @ApiProperty({ description: 'Instante en que vence este reloj.' })
  dueAt!: Date;
  @ApiProperty({ nullable: true }) stoppedAt!: Date | null;
  @ApiProperty({ nullable: true }) breachedAt!: Date | null;
  @ApiProperty({
    enum: ['running', 'met', 'breached'],
    description: 'Se deriva de las fechas; no hay un campo de estado guardado.',
  })
  status!: string;
  @ApiProperty({
    description:
      'Minutos de margen, negativos si se pasó. El reloj en marcha se mide contra ahora; el parado, contra su hora de parada.',
  })
  remainingMinutes!: number;
}

export class TicketDetailDto extends TicketSummaryDto {
  @ApiProperty() description!: string;
  @ApiProperty({ nullable: true }) resolvedAt!: Date | null;
  @ApiProperty({ nullable: true }) closedAt!: Date | null;
  @ApiProperty({ type: [TicketCommentDto] }) comments!: TicketCommentDto[];
  @ApiProperty({ type: [TicketSlaDto] }) sla!: TicketSlaDto[];
}

export class TicketPageDto {
  @ApiProperty({ type: [TicketSummaryDto] }) items!: TicketSummaryDto[];
  @ApiProperty({
    nullable: true,
    description: 'Cursor de la página siguiente; `null` si no hay más.',
  })
  nextCursor!: string | null;
}

export class AuditEntryDto {
  @ApiProperty() id!: string;
  @ApiProperty() actorId!: string;
  @ApiProperty({ example: 'ticket.status_changed' }) action!: string;
  @ApiProperty({ nullable: true, type: Object }) metadata!: unknown;
  @ApiProperty() occurredAt!: Date;
}
