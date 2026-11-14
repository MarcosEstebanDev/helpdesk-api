import { ApiProperty } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsString,
  MaxLength,
} from 'class-validator';

/**
 * Solo la FORMA. Las reglas (al menos un día hábil, cierre después de la
 * apertura, zona que exista, fecha real) viven en el dominio y en los casos de
 * uso, como con el SLA: en el DTO se las saltaría cualquier otra entrada.
 */
export class UpdateBusinessHoursDto {
  @ApiProperty({ enum: ['business_hours', '24_7'] })
  @IsIn(['business_hours', '24_7'])
  mode!: 'business_hours' | '24_7';

  @ApiProperty({ example: 'America/Argentina/Buenos_Aires' })
  @IsString()
  @MaxLength(64)
  timeZone!: string;

  @ApiProperty({
    type: [Number],
    example: [1, 2, 3, 4, 5],
    description: '1 = lunes … 7 = domingo',
  })
  @IsArray()
  @IsInt({ each: true })
  weekdays!: number[];

  @ApiProperty({ example: '08:00' })
  @IsString()
  opensAt!: string;

  @ApiProperty({ example: '18:00' })
  @IsString()
  closesAt!: string;
}

export class AddCalendarExceptionDto {
  @ApiProperty({
    example: '2026-12-25',
    description: 'Fecha local de la organización.',
  })
  @IsString()
  date!: string;

  @ApiProperty({
    description: '`false` = no hábil (feriado); `true` = día hábil extra.',
  })
  @IsBoolean()
  working!: boolean;

  @ApiProperty({ example: 'Navidad' })
  @IsString()
  @MaxLength(200)
  name!: string;
}

export class CalendarExceptionDto {
  @ApiProperty() id!: string;
  @ApiProperty({ example: '2026-12-25' }) date!: string;
  @ApiProperty() working!: boolean;
  @ApiProperty() name!: string;
}

export class BusinessHoursDto {
  @ApiProperty({ enum: ['business_hours', '24_7'] }) mode!: string;
  @ApiProperty() timeZone!: string;
  @ApiProperty({ type: [Number] }) weekdays!: number[];
  @ApiProperty({ example: '08:00' }) opensAt!: string;
  @ApiProperty({ example: '18:00' }) closesAt!: string;
  @ApiProperty({ enum: ['default', 'organization'] }) source!: string;
  @ApiProperty({ type: [CalendarExceptionDto] })
  exceptions!: CalendarExceptionDto[];
}

export class HolidaysLoadedDto {
  @ApiProperty() added!: number;
  @ApiProperty({
    description: 'Fechas que ya tenían una excepción y no se tocaron.',
  })
  skipped!: number;
}

export class BusinessStatusDto {
  @ApiProperty() open!: boolean;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  nextOpening!: Date | null;
  @ApiProperty() timeZone!: string;
}
