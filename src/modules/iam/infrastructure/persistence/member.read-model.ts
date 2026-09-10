import { Injectable } from '@nestjs/common';
import { PrismaRepository } from '../../../../infrastructure/prisma/prisma.repository';
import { PrismaService } from '../../../../infrastructure/prisma/prisma.service';
import { TenantId, UserId } from '../../domain/ids';
import { Role } from '../../domain/role';

/**
 * Lado de LECTURA del directorio de miembros (CQRS-lite, ADR-0008; ADR-0025).
 *
 * No pasa por el dominio ni por los repositorios de `iam`: consulta Prisma y
 * devuelve directamente la forma que la API necesita. Rehidratar `User` y
 * `Membership` para luego aplanarlos no aportaría ninguna regla de negocio —
 * aquí no se decide nada, solo se enseña quién está en la organización.
 *
 * Vive en `infrastructure/` justamente porque conoce Prisma: en `application/`
 * rompería la regla de dependencias.
 *
 * **Se consulta desde `membership`, no desde `user`.** Es la tabla que tiene el
 * `role`, así que preguntando por ella el rol nunca puede faltar. Al revés
 * —listar usuarios y adjuntar su membership— habría que decidir qué hacer con un
 * usuario sin membership, y el DTO tendría un `role` opcional que ningún cliente
 * sabría interpretar. Un usuario sin membership no es miembro: no sale.
 */

/**
 * Un miembro de la organización tal y como lo ve la API.
 *
 * El identificador se llama `userId` y no `id` a propósito: es el valor que
 * referencian `assigneeId`, `requesterId` y `authorId`. Llamarlo `id` invitaría
 * a confundirlo con el id del membership, que no sirve para nada de eso.
 */
export interface MemberView {
  userId: string;
  email: string;
  role: Role;
  joinedAt: Date;
}

/**
 * Forma de la fila que devuelve Prisma. Se declara explícita para que el
 * `select` y el mapeo no puedan desincronizarse en silencio.
 */
interface MembershipRow {
  role: Role;
  createdAt: Date;
  user: { id: string; email: string };
}

/**
 * `users` guarda `password_hash` en la MISMA tabla, así que la proyección se
 * escribe campo a campo y nunca con un spread de la fila: un `select` que
 * crezca por descuido no puede acabar en la respuesta HTTP.
 */
const toMemberView = (row: MembershipRow): MemberView => ({
  userId: row.user.id,
  email: row.user.email,
  role: row.role,
  joinedAt: row.createdAt,
});

/** `select` único: la lista y el detalle proyectan exactamente lo mismo. */
const MEMBER_SELECT = {
  role: true,
  createdAt: true,
  user: { select: { id: true, email: true } },
} as const;

@Injectable()
export class MemberReadModel extends PrismaRepository {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  /**
   * Todos los miembros de la organización, ordenados por email.
   *
   * **Sin paginación y sin filtros, a propósito** (ADR-0025): el número de
   * miembros está acotado por la plantilla de la organización, y el consumidor
   * real —un selector de personas— necesita la lista entera para poder buscar
   * dentro sin ir y volver al servidor en cada tecla.
   *
   * El orden lo pone la base de datos sobre la relación to-one `user`. Si eso
   * diera problemas, la alternativa es ordenar en JS (son decenas de filas):
   *
   *   rows.sort((a, b) => a.user.email.localeCompare(b.user.email))
   */
  async list(tenantId: TenantId): Promise<MemberView[]> {
    return this.runInTenant(tenantId, async (tx) => {
      const rows = await tx.membership.findMany({
        where: { tenantId },
        select: MEMBER_SELECT,
        orderBy: { user: { email: 'asc' } },
      });
      return rows.map(toMemberView);
    });
  }

  /**
   * Un miembro concreto, o `null` si ese usuario no pertenece a la organización.
   *
   * Lo usa `GET /auth/me` para componer el principal. Devolver `null` en vez de
   * lanzar deja la decisión de qué código HTTP corresponde en el borde, que es
   * quien sabe si "no está" significa 404 o 401.
   */
  async findById(
    tenantId: TenantId,
    userId: UserId,
  ): Promise<MemberView | null> {
    return this.runInTenant(tenantId, async (tx) => {
      const row = await tx.membership.findUnique({
        where: { tenantId_userId: { tenantId, userId } },
        select: MEMBER_SELECT,
      });
      return row === null ? null : toMemberView(row);
    });
  }
}
