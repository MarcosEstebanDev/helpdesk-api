import { Result, ValueObject, ok, err } from '../../../../shared-kernel';
import { WeakPasswordError } from '../errors';

/**
 * Password en texto plano que cumple la política mínima. Es TRANSITORIO: existe
 * solo para validar y luego hashearse (vía el puerto PasswordHasher); nunca se
 * persiste ni se loguea. Su contraparte persistida es {@link PasswordHash}.
 */
export class Password extends ValueObject<{ value: string }> {
  static readonly MIN_LENGTH = 8;
  static readonly MAX_LENGTH = 200;

  private constructor(value: string) {
    super({ value });
  }

  get value(): string {
    return this.props.value;
  }

  static create(raw: string): Result<Password, WeakPasswordError> {
    if (raw.length < Password.MIN_LENGTH) {
      return err(
        new WeakPasswordError(
          `El password debe tener al menos ${Password.MIN_LENGTH} caracteres.`,
        ),
      );
    }
    // Límite superior: argon2 sobre inputs enormes es un vector de DoS.
    if (raw.length > Password.MAX_LENGTH) {
      return err(
        new WeakPasswordError(
          `El password no puede superar ${Password.MAX_LENGTH} caracteres.`,
        ),
      );
    }
    return ok(new Password(raw));
  }
}
