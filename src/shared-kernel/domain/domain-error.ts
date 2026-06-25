/**
 * Base for domain/application errors-as-values (ADR-0005). A `DomainError` is an
 * expected business outcome (e.g. "invalid credentials"), not a thrown exception.
 * `code` is a stable, machine-readable discriminator that the HTTP edge maps to a
 * status code; `message` is human-readable and safe to surface.
 */
export abstract class DomainError {
  abstract readonly code: string;

  protected constructor(readonly message: string) {}
}
