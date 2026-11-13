import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { SAVED_VIEW_NAME_MAX } from '../../../domain/saved-view/saved-view.entity';
import { Trim } from './transforms';

/**
 * Vista guardada (ADR-0033). `class-validator` mira la forma; qué filtros son
 * válidos lo decide el dominio (`parseViewFilters`), que nombra el campo malo.
 */
export class CreateSavedViewDto {
  @ApiProperty({ maxLength: SAVED_VIEW_NAME_MAX, example: 'Mis urgentes' })
  @IsString()
  @Trim()
  @MaxLength(SAVED_VIEW_NAME_MAX)
  name!: string;

  @ApiProperty({
    description:
      'Filtros v1: { version: 1, status?, assignee?: "me", tagIds?, q?, aiSuggestsHigher?: true }.',
    example: { version: 1, assignee: 'me', status: 'IN_PROGRESS' },
  })
  @IsObject()
  filters!: Record<string, unknown>;

  @ApiPropertyOptional({
    default: false,
    description: 'Compartida con todo el equipo. Solo ADMIN.',
  })
  @IsOptional()
  @IsBoolean()
  shared?: boolean;
}

export class UpdateSavedViewDto {
  @ApiProperty({ maxLength: SAVED_VIEW_NAME_MAX })
  @IsString()
  @Trim()
  @MaxLength(SAVED_VIEW_NAME_MAX)
  name!: string;

  @ApiProperty()
  @IsObject()
  filters!: Record<string, unknown>;
}

export class SavedViewDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() shared!: boolean;
  @ApiProperty() filters!: Record<string, unknown>;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
}

export class SavedViewListDto {
  @ApiProperty({ type: [SavedViewDto] }) items!: SavedViewDto[];
}
