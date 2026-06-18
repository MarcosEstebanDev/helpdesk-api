/**
 * Result type — explicit, type-safe error handling for the domain and
 * application layers. Business errors are expected flow, not exceptions:
 * a use case returns `Result<T, DomainError>` instead of throwing.
 *
 * ADR-0005: errors-as-values in domain/application; exceptions only at the edges.
 */
export type Result<T, E = Error> = Ok<T, E> | Err<T, E>;

export class Ok<T, E> {
  readonly _tag = 'Ok' as const;

  constructor(public readonly value: T) {}

  isOk(): this is Ok<T, E> {
    return true;
  }

  isErr(): this is Err<T, E> {
    return false;
  }
}

export class Err<T, E> {
  readonly _tag = 'Err' as const;

  constructor(public readonly error: E) {}

  isOk(): this is Ok<T, E> {
    return false;
  }

  isErr(): this is Err<T, E> {
    return true;
  }
}

export const ok = <T, E = never>(value: T): Result<T, E> => new Ok(value);

export const err = <T = never, E = unknown>(error: E): Result<T, E> =>
  new Err(error);
