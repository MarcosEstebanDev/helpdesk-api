import { TenantId, UserId } from '../ids';
import { Email } from '../value-objects/email.vo';
import { User } from '../entities/user.entity';

/**
 * Puerto de persistencia de usuarios. Las implementaciones (2c) corren cada
 * lectura dentro de `PrismaService.withTenant(tenantId, ...)` para que RLS aplique.
 */
export interface UserRepository {
  findByEmail(tenantId: TenantId, email: Email): Promise<User | null>;
  findById(tenantId: TenantId, id: UserId): Promise<User | null>;
}

export const USER_REPOSITORY = Symbol('iam.UserRepository');
