// Primero, antes de AppModule: ver el comentario del propio archivo.
import './support/refresh-cookie-path-env';

import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';

/**
 * El front detrás de su propio proxy (ADR-0035).
 *
 * El navegador compara el `Path` de la cookie con la URL que VE
 * (`https://web/api/auth/refresh`), no con la que recibe la API
 * (`/auth/refresh`). Con `Path=/auth` la cookie del refresh se guardaría y no
 * viajaría nunca: la sesión se perdería al recargar, que es justo lo que el
 * proxy viene a arreglar. Por eso el path es configurable, y por eso el BORRADO
 * tiene que usar el mismo: una cookie solo se pisa con su mismo path.
 */
describe('Path de la cookie del refresh configurable (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  const run = randomUUID().slice(0, 8);
  const orgSlug = `cookie-${run}`;
  const email = `ana@cookie-${run}.test`;
  const password = 'un-password-seguro';
  let tenantId: string | undefined;

  const cookieDeRefresh = (res: request.Response): string => {
    const raw = res.headers['set-cookie'] as unknown as string[] | undefined;
    const cookie = raw?.find((c) => c.startsWith('refresh_token='));
    if (cookie === undefined) {
      throw new Error('La respuesta no trae cookie refresh_token.');
    }
    return cookie;
  };

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    if (tenantId !== undefined) {
      const id = tenantId;
      await prisma.withTenant(id, (tx) =>
        tx.organization.deleteMany({ where: { id } }),
      );
    }
    await app.close();
  });

  it('emite la cookie con el path configurado y la borra con el mismo', async () => {
    const registro = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ organizationName: `Cookie ${run}`, email, password })
      .expect(201);
    const { accessToken } = registro.body as { accessToken: string };
    tenantId = (
      JSON.parse(
        Buffer.from(accessToken.split('.')[1], 'base64url').toString('utf8'),
      ) as { tenantId: string }
    ).tenantId;

    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ organizationSlug: orgSlug, email, password })
      .expect(200);
    const emitida = cookieDeRefresh(login);
    expect(emitida).toContain('Path=/api/auth');
    expect(emitida).not.toMatch(/Path=\/auth(;|$)/);

    // La API sigue atendiendo en /auth: el prefijo /api solo existe en el proxy.
    const logout = await request(app.getHttpServer())
      .post('/auth/logout')
      .set('Cookie', emitida.split(';')[0])
      .expect(204);
    expect(cookieDeRefresh(logout)).toContain('Path=/api/auth');
  });
});
