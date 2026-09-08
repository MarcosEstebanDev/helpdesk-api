import type {
  Membership as MembershipRow,
  RefreshToken as RefreshTokenRow,
  User as UserRow,
} from '@prisma/client';
import {
  MembershipId,
  RefreshFamilyId,
  RefreshTokenId,
  TenantId,
  UserId,
} from '../../domain/ids';
import { isRole } from '../../domain/role';
import { Membership } from '../../domain/entities/membership.entity';
import { RefreshToken } from '../../domain/entities/refresh-token.entity';
import { User } from '../../domain/entities/user.entity';
import { Email } from '../../domain/value-objects/email.vo';
import { PasswordHash } from '../../domain/value-objects/password-hash.vo';

/**
 * Mappers fila -> entidad de dominio.
 *
 * Si una fila no puede convertirse, es una **invariante rota** (datos corruptos
 * o una migración mal hecha), no flujo de negocio: por eso lanzan en vez de
 * devolver `Result`. Un `Result` acá obligaría a los repos a propagar un error
 * que ningún caso de uso puede manejar de forma útil.
 */

export const toUser = (row: UserRow): User => {
  const email = Email.create(row.email);
  if (email.isErr()) {
    throw new Error(`Email inválido en base de datos (user ${row.id}).`);
  }
  return User.rehydrate({
    id: UserId(row.id),
    tenantId: TenantId(row.tenantId),
    email: email.value,
    passwordHash: PasswordHash.fromHash(row.passwordHash),
    createdAt: row.createdAt,
  });
};

export const toMembership = (row: MembershipRow): Membership => {
  // Se ensancha a `string` a propósito: si se estrecha directamente el enum de
  // Prisma, la rama de error queda tipada como `never` y ni siquiera se puede
  // interpolar el valor en el mensaje.
  const role: string = row.role;
  if (!isRole(role)) {
    throw new Error(`Rol desconocido en base de datos: "${role}".`);
  }
  return Membership.rehydrate({
    id: MembershipId(row.id),
    tenantId: TenantId(row.tenantId),
    userId: UserId(row.userId),
    role,
    createdAt: row.createdAt,
  });
};

export const toRefreshToken = (row: RefreshTokenRow): RefreshToken =>
  RefreshToken.rehydrate({
    id: RefreshTokenId(row.id),
    tenantId: TenantId(row.tenantId),
    userId: UserId(row.userId),
    familyId: RefreshFamilyId(row.familyId),
    tokenHash: row.tokenHash,
    expiresAt: row.expiresAt,
    rotatedAt: row.rotatedAt,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
  });
