/**
 * Branded types for ids. In a multi-tenant system, mixing up a `TenantId`
 * and a `UserId` is a data-leak waiting to happen; branding makes the
 * compiler reject passing the wrong id where another is expected — security
 * by design (ADR-0006).
 *
 * Usage in a bounded context:
 *   export type TenantId = Brand<string, 'TenantId'>;
 *   export const TenantId = (raw: string) => brand<'TenantId'>(raw);
 */
export type Brand<T, B extends string> = T & { readonly __brand: B };

export const brand = <B extends string>(value: string): Brand<string, B> =>
  value as Brand<string, B>;
