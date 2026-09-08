import { createParamDecorator } from '@nestjs/common';
import {
  TenantContext,
  requireTenantContext,
} from '../../../../infrastructure/tenant/tenant-context';

/**
 * Inyecta el principal autenticado en un handler. Se lee del contexto, NO de la
 * request: así es imposible que un header o un body lo suplanten.
 *
 * Requiere {@link JwtAuthGuard} en la ruta.
 */
export const CurrentUser = createParamDecorator(
  (): TenantContext => requireTenantContext(),
);
