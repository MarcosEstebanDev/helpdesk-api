import { ApiProperty } from '@nestjs/swagger';
import { ROLES } from '../../../domain/role';

/**
 * Un miembro de la organización, tal y como sale por HTTP (ADR-0025).
 *
 * Cuatro campos elegidos uno a uno. Lo que NO está también es una decisión:
 *
 * - **el id del membership**, que es un surrogate interno: la identidad
 *   direccionable de un miembro es su `userId`, y exponer otra invitaría al
 *   cliente a usarla y atar el contrato a un detalle de almacenamiento;
 * - **el `tenantId`**, que es el del propio llamante: devolverlo sugiere que es
 *   un parámetro, y en este sistema el tenant nunca es un parámetro;
 * - cualquier rastro de actividad de la cuenta, que sería telemetría sobre
 *   compañeros de trabajo y no un directorio.
 */
export class MemberDto {
  @ApiProperty({
    format: 'uuid',
    description:
      'Identificador del USUARIO, que es el que piden `assigneeId` y compañía.',
  })
  userId!: string;

  @ApiProperty({
    description:
      'Hoy es la única etiqueta legible que existe: no hay columna `name`.',
  })
  email!: string;

  @ApiProperty({ enum: ROLES })
  role!: string;

  @ApiProperty({ description: 'Cuándo se unió a la organización.' })
  joinedAt!: Date;
}

/**
 * La lista va envuelta en un objeto y no como array pelado.
 *
 * Hoy no hay paginación (ADR-0025) y el envoltorio no aporta nada, pero el día
 * que haga falta, añadir `nextCursor` es un cambio ADITIVO del OpenAPI;
 * convertir un array en objeto rompería a todos los clientes. Cuesta cero
 * ahora y evita un cambio rompedor después.
 */
export class MemberListDto {
  @ApiProperty({ type: [MemberDto] })
  items!: MemberDto[];
}
