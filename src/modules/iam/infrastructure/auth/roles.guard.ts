import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { getTenantContext } from '../../../../infrastructure/tenant/tenant-context';
import { Role, hasAtLeastRole, isRole } from '../../domain/role';
import { MIN_ROLE_KEY } from './min-role.decorator';

/**
 * Autorización por rango de rol (ADR-0014).
 *
 * Se registra como guard GLOBAL, pero **no exige nada por defecto**: una ruta sin
 * `@MinRole` pasa de largo. La alternativa (denegar por defecto) suena más segura
 * pero obligaría a marcar como públicas rutas que ya están protegidas por
 * `JwtAuthGuard`, y esa doble anotación es justo donde se cuelan los olvidos.
 *
 * El rol se lee del contexto de tenant —que nació de un JWT verificado— y jamás
 * del body, la query o una cabecera. Es el mismo principio que el `tenantId`.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Role | undefined>(
      MIN_ROLE_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (required === undefined) {
      return true; // la ruta no declara requisito de rol
    }

    const principal = getTenantContext();
    if (principal === null) {
      // Falta la sesión, no el permiso: 401 y no 403. Suele significar que a la
      // ruta se le puso @MinRole pero se le olvidó el JwtAuthGuard.
      throw new UnauthorizedException('Se requiere autenticación.');
    }

    // El contexto guarda el rol como string para no acoplar la infraestructura
    // transversal al dominio de iam; acá se valida antes de compararlo.
    if (!isRole(principal.role) || !hasAtLeastRole(principal.role, required)) {
      throw new ForbiddenException(
        `Se requiere el rol ${required} o superior.`,
      );
    }

    return true;
  }
}
