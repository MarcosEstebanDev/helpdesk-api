import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, Length, MaxLength } from 'class-validator';

/**
 * DTOs del borde HTTP. Validan **forma** (que sea un string, que no venga vacío);
 * las reglas de negocio (política de password, formato de email canónico) viven
 * en los Value Objects del dominio. Duplicar aquí esas reglas las desincronizaría.
 */

export class RegisterOrganizationDto {
  @ApiProperty({ example: 'Acme SL', minLength: 2, maxLength: 120 })
  @IsString()
  @Length(2, 120)
  organizationName!: string;

  @ApiProperty({ example: 'ana@acme.com' })
  @IsEmail()
  @MaxLength(320)
  email!: string;

  @ApiProperty({ example: 'un-password-seguro', minLength: 8, maxLength: 200 })
  @IsString()
  @Length(8, 200)
  password!: string;
}

export class LoginDto {
  @ApiProperty({
    example: 'acme-sl',
    description: 'Slug de la organización; el email es único POR tenant.',
  })
  @IsString()
  @Length(1, 140)
  organizationSlug!: string;

  @ApiProperty({ example: 'ana@acme.com' })
  @IsEmail()
  @MaxLength(320)
  email!: string;

  @ApiProperty({ example: 'un-password-seguro' })
  @IsString()
  @Length(1, 200)
  password!: string;
}

export class AuthResponseDto {
  @ApiProperty({
    description:
      'JWT de acceso (15 min). El refresh token NO viaja en el body: va en una cookie httpOnly.',
  })
  accessToken!: string;
}

export class MeResponseDto {
  @ApiProperty() userId!: string;
  @ApiProperty() tenantId!: string;
  @ApiProperty({ enum: ['ADMIN', 'AGENT', 'VIEWER'] }) role!: string;
}
