import { Password } from '../value-objects/password.vo';
import { PasswordHash } from '../value-objects/password-hash.vo';

/**
 * Puerto de hashing de passwords (argon2id en 2c). `verify` recibe el texto plano
 * tal cual lo mandó el cliente en login (sin re-validar política): solo compara.
 */
export interface PasswordHasher {
  hash(password: Password): Promise<PasswordHash>;
  verify(plain: string, hash: PasswordHash): Promise<boolean>;
}

export const PASSWORD_HASHER = Symbol('iam.PasswordHasher');
