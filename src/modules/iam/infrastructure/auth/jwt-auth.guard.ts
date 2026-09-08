import { CanActivate, Injectable, UnauthorizedException } from '@nestjs/common';
import { getTenantContext } from '../../../../infrastructure/tenant/tenant-context';

/**
 * Exige una request autenticada. El trabajo de verificar la firma ya lo hizo
 * {@link TenantContextMiddleware}; acá solo se comprueba que haya contexto.
 *
 * Esa separación importa: el guard no puede "colarse" un tenant, porque no lo
 * lee de ningún sitio manipulable por el cliente — solo del contexto que nació
 * de un token verificado.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  canActivate(): boolean {
    if (getTenantContext() === null) {
      throw new UnauthorizedException('Se requiere autenticación.');
    }
    return true;
  }
}
