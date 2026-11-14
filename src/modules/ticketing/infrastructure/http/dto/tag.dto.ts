import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { LowercaseIds, Trim } from './transforms';
import {
  MAX_TAGS_PER_TICKET,
  TAG_COLORS,
  TAG_NAME_MAX,
} from '../../../domain/tag/tag.entity';

/**
 * Etiquetas (ADR-0031). `class-validator` mira la FORMA; la unicidad y el
 * recorte son del dominio. El máximo por ticket también se valida en el
 * dominio, y aquí se repite solo para cortar antes un array enorme.
 */
export class CreateTagDto {
  @ApiProperty({ maxLength: TAG_NAME_MAX, example: 'Facturación' })
  @IsString()
  @Trim()
  @MaxLength(TAG_NAME_MAX)
  name!: string;

  @ApiPropertyOptional({ enum: TAG_COLORS, default: 'gray' })
  @IsOptional()
  @IsIn(TAG_COLORS)
  color?: string;
}

export class UpdateTagDto {
  @ApiPropertyOptional({ maxLength: TAG_NAME_MAX })
  @IsOptional()
  @IsString()
  @Trim()
  @MaxLength(TAG_NAME_MAX)
  name?: string;

  @ApiPropertyOptional({ enum: TAG_COLORS })
  @IsOptional()
  @IsIn(TAG_COLORS)
  color?: string;
}

export class SetTicketTagsDto {
  @ApiProperty({
    type: [String],
    format: 'uuid',
    maxItems: MAX_TAGS_PER_TICKET,
    description: 'Reemplaza el conjunto entero. Duplicados se ignoran.',
  })
  @LowercaseIds()
  @IsArray()
  // El máximo REAL (10) es del dominio y cuenta después de quitar repetidos:
  // 11 copias del mismo id son una etiqueta. Esto solo corta un abuso.
  @ArrayMaxSize(100)
  @IsUUID('all', { each: true })
  tagIds!: string[];
}

export class TagDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: TAG_COLORS }) color!: string;
}

export class TagListDto {
  @ApiProperty({ type: [TagDto] }) items!: TagDto[];
}

export class TicketTagsDto {
  @ApiProperty({ type: [TagDto] }) tags!: TagDto[];
}
