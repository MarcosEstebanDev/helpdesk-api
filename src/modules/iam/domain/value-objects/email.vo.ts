import { Result, ValueObject, ok, err } from '../../../../shared-kernel';
import { InvalidEmailError } from '../errors';

// Pragmático: valida la forma, no la RFC 5322 completa. La verificación real es
// el envío del email de confirmación (fase posterior).
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Email normalizado (trim + lowercase) y con formato válido. Inmutable.
 */
export class Email extends ValueObject<{ value: string }> {
  private constructor(value: string) {
    super({ value });
  }

  get value(): string {
    return this.props.value;
  }

  static create(raw: string): Result<Email, InvalidEmailError> {
    const normalized = raw.trim().toLowerCase();
    if (!EMAIL_REGEX.test(normalized)) {
      return err(new InvalidEmailError(raw));
    }
    return ok(new Email(normalized));
  }
}
