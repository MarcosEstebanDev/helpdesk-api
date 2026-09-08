import { SetMetadata } from '@nestjs/common';
import { Role } from '../../domain/role';

export const MIN_ROLE_KEY = 'iam:min-role';

/**
 * Exige un rango mínimo para acceder a la ruta (ADR-0014).
 *
 * Se llama `MinRole` y no `Roles` a propósito: los roles forman una jerarquía,
 * así que `@MinRole('AGENT')` significa "AGENT **o superior**", no "solo AGENT".
 * Un decorador llamado `@Roles('AGENT')` se leería como lo segundo y llevaría a
 * escribir `@Roles('AGENT', 'ADMIN')` por todas partes, duplicando la jerarquía
 * en cada ruta en vez de aplicarla en un sitio.
 *
 * Requiere que la ruta esté además protegida por `JwtAuthGuard`: sin sesión no
 * hay rol que comparar.
 */
export const MinRole = (role: Role): MethodDecorator & ClassDecorator =>
  SetMetadata(MIN_ROLE_KEY, role);
