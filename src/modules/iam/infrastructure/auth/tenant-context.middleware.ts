import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { runWithTenantContext } from '../../../../infrastructure/tenant/tenant-context';
import { AccessTokenVerifier } from './access-token.verifier';

/**
 * Establece el contexto de tenant para toda la request a partir del access token.
 *
 * **Por qué middleware y no interceptor:** `AsyncLocalStorage` propaga el contexto
 * a través de la cadena de callbacks que se ejecutan DENTRO de `run()`. Un
 * interceptor de Nest devuelve un Observable que Nest suscribe más tarde, fuera
 * de ese scope, y el contexto se perdería. El middleware envuelve `next()`, que
 * sí ejecuta el resto del pipeline dentro del scope.
 *
 * No rechaza requests sin token: solo no establece contexto. Decidir si eso es
 * un 401 es responsabilidad del {@link JwtAuthGuard}, ruta por ruta.
 */
@Injectable()
export class TenantContextMiddleware implements NestMiddleware {
  constructor(private readonly verifier: AccessTokenVerifier) {}

  async use(req: Request, _res: Response, next: NextFunction): Promise<void> {
    const token = AccessTokenVerifier.extractBearer(req.headers.authorization);
    if (token === null) {
      next();
      return;
    }

    const principal = await this.verifier.verify(token);
    if (principal === null) {
      next();
      return;
    }

    runWithTenantContext(principal, () => next());
  }
}
