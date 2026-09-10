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

/**
 * El principal autenticado.
 *
 * Cada campo tiene un origen deliberado (ADR-0025, decisión 5): el `email` se
 * LEE de la base de datos y el `role` sale del TOKEN. No es una incoherencia:
 * los guards autorizan comparando contra el rol del token, así que devolver aquí
 * un rol fresco haría que la interfaz habilitara acciones que cada petición
 * rechazaría con 403 hasta que el token caducase. Un desfase conocido y
 * coherente es mejor que dos verdades simultáneas.
 */
export class MeResponseDto {
  @ApiProperty() userId!: string;
  @ApiProperty() tenantId!: string;
  @ApiProperty({ enum: ['ADMIN', 'AGENT', 'VIEWER'] }) role!: string;
  @ApiProperty({ description: 'Se lee de la base, no viaja en el token.' })
  email!: string;
}
