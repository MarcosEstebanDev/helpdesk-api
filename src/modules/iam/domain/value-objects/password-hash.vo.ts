import { ValueObject } from '../../../../shared-kernel';

/**
 * Hash de password ya calculado por el puerto PasswordHasher (argon2id en 2c).
 * El dominio nunca ve el texto plano persistido: guarda y compara contra este VO.
 */
export class PasswordHash extends ValueObject<{ value: string }> {
  private constructor(value: string) {
    super({ value });
  }

  get value(): string {
    return this.props.value;
  }

  /** Crea el VO a partir de un hash ya producido por el hasher. */
  static fromHash(value: string): PasswordHash {
    if (!value || value.trim().length === 0) {
      // Invariante interna: si esto falla es un bug del hasher, no flujo de negocio.
      throw new Error('PasswordHash no puede ser vacío.');
    }
    return new PasswordHash(value);
  }
}
