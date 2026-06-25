import { DomainError } from '../../../shared-kernel';

/**
 * Errores de dominio del contexto IAM (errores-as-values, ADR-0005). El `code`
 * es estable y lo mapea el borde HTTP (2c) a un status. Los mensajes no filtran
 * si el problema fue el email o el password en login (anti enumeración de cuentas).
 */
export class InvalidEmailError extends DomainError {
  readonly code = 'iam.invalid_email';
  constructor(raw: string) {
    super(`El email "${raw}" no tiene un formato válido.`);
  }
}

export class WeakPasswordError extends DomainError {
  readonly code = 'iam.weak_password';
  constructor(reason: string) {
    super(reason);
  }
}

export class InvalidOrganizationNameError extends DomainError {
  readonly code = 'iam.invalid_organization_name';
  constructor() {
    super('El nombre de la organización no es válido.');
  }
}

export class OrganizationNameTakenError extends DomainError {
  readonly code = 'iam.organization_name_taken';
  constructor(slug: string) {
    super(`Ya existe una organización con el identificador "${slug}".`);
  }
}

export class InvalidCredentialsError extends DomainError {
  readonly code = 'iam.invalid_credentials';
  constructor() {
    super('Credenciales inválidas.');
  }
}

export class RefreshTokenInvalidError extends DomainError {
  readonly code = 'iam.refresh_token_invalid';
  constructor() {
    super('El refresh token es inválido o expiró.');
  }
}

/**
 * Se presentó un refresh token ya rotado o revocado: indicio de robo. La familia
 * completa se revoca como respuesta.
 */
export class RefreshTokenReuseError extends DomainError {
  readonly code = 'iam.refresh_token_reuse';
  constructor() {
    super(
      'Se detectó reutilización de un refresh token; la sesión fue revocada.',
    );
  }
}

export type IamError =
  | InvalidEmailError
  | WeakPasswordError
  | InvalidOrganizationNameError
  | OrganizationNameTakenError
  | InvalidCredentialsError
  | RefreshTokenInvalidError
  | RefreshTokenReuseError;
