import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import cookieParser from 'cookie-parser';
import type { NextFunction, Request, Response } from 'express';
import type { Env } from './infrastructure/config/env.schema';
import { requestIdMiddleware } from './infrastructure/observability/request-id.middleware';
import { TenantContextMiddleware } from './modules/iam/infrastructure/auth/tenant-context.middleware';

/**
 * Configuración del pipeline HTTP, compartida por `main.ts` y por los tests e2e.
 *
 * Vive fuera de `bootstrap()` a propósito: si los e2e montaran la app con una
 * configuración distinta a la de producción, pasarían tests sobre un sistema que
 * no es el que se despliega — el fallo más caro y silencioso de una suite e2e.
 */
export function configureApp(app: INestApplication): void {
  // Correlación PRIMERO: todo lo que ocurra después —validación, auth, la
  // petición entera— tiene que poder decir a qué request pertenece.
  app.use(requestIdMiddleware);

  // Rechaza campos desconocidos en el borde: defensa ante mass assignment.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  // CORS con credenciales: el navegador exige el origen EXACTO (nunca `*`) y
  // `Access-Control-Allow-Credentials` para dejar viajar la cookie httpOnly del
  // refresh token. Con `enableCors()` a secas el front no puede ni renovar
  // sesión, y no hay test de backend que lo detecte: supertest no aplica CORS.
  const config = app.get(ConfigService<Env, true>);
  app.enableCors({
    origin: config.get('CORS_ORIGINS', { infer: true }),
    credentials: true,
  });

  // El refresh token viaja en cookie httpOnly (ADR-0011): hay que parsearla
  // antes de que los controllers la lean.
  app.use(cookieParser());

  // Contexto de tenant para TODAS las rutas.
  //
  // Se registra como middleware global y no con `configure(consumer).forRoutes()`
  // a propósito: Nest 11 usa Express 5, cuya sintaxis de comodines en rutas
  // cambió (`'*'` ya no es válido). Así no dependemos de esa sintaxis.
  const tenantContext = app.get(TenantContextMiddleware);
  app.use((req: Request, res: Response, next: NextFunction) => {
    void tenantContext.use(req, res, next);
  });
}
