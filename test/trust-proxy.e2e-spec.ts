// Primero, antes de AppModule: ver el comentario del propio archivo.
import './support/trust-proxy-env';

import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import { LOGIN_THROTTLE } from '../src/modules/iam/infrastructure/http/throttle.policy';

// Con el guard REAL, igual que auth-rate-limit.e2e-spec.ts.
delete process.env.THROTTLE_SKIP;

/**
 * La API detrás de un proxy inverso (adenda del ADR-0013).
 *
 * En producción todas las peticiones llegan desde Caddy. Sin `trust proxy`,
 * Express ve la IP del proxy para todo el mundo y el rate limiting por IP se
 * vuelve GLOBAL: cinco logins fallidos de cualquiera bloquean a todos.
 *
 * Con `TRUST_PROXY_HOPS=1` Express toma la IP que añadió el ÚLTIMO salto de
 * `X-Forwarded-For` (el proxy), y nada de lo que el cliente escribió a la
 * izquierda. Esta suite comprueba las dos mitades: que dos clientes reales
 * tienen contadores separados, y que falsificar la cabecera no los separa.
 */
describe('Detrás de un proxy (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  const run = randomUUID().slice(0, 8);
  const orgSlug = `proxy-${run}`;
  const email = `ana@proxy-${run}.test`;
  const password = 'un-password-seguro';

  // Rango de documentación (RFC 5737): nunca es una IP real.
  const IP_ATACANTE = '203.0.113.10';
  const IP_LEGITIMA = '203.0.113.20';

  let tenantId: string;

  const login = (forwardedFor: string) =>
    request(app.getHttpServer())
      .post('/auth/login')
      .set('X-Forwarded-For', forwardedFor)
      .send({ organizationSlug: orgSlug, email, password: 'incorrecto' });

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);

    const res = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ organizationName: `Proxy ${run}`, email, password })
      .expect(201);

    const { accessToken } = res.body as { accessToken: string };
    const claims = Buffer.from(accessToken.split('.')[1], 'base64url').toString(
      'utf8',
    );
    tenantId = (JSON.parse(claims) as { tenantId: string }).tenantId;

    // Agota el límite de login desde la IP del atacante.
    for (let i = 0; i < LOGIN_THROTTLE.limit; i++) {
      await login(IP_ATACANTE).expect(401);
    }
    await login(IP_ATACANTE).expect(429);
  });

  afterAll(async () => {
    await prisma.withTenant(tenantId, (tx) =>
      tx.organization.deleteMany({ where: { id: tenantId } }),
    );
    await app.close();
    // Los e2e corren en un solo proceso (--runInBand): no dejarla puesta para
    // las suites que vienen detrás.
    delete process.env.TRUST_PROXY_HOPS;
  });

  it('otro cliente detrás del mismo proxy NO queda bloqueado', async () => {
    await login(IP_LEGITIMA).expect(401);
  });

  it('falsificar X-Forwarded-For no salta el límite', async () => {
    // El cliente escribe lo que quiera a la izquierda; el proxy AÑADE la IP
    // real al final. Con un salto de confianza, solo cuenta esa última.
    for (const inventada of ['198.51.100.1', '198.51.100.2', '10.0.0.1']) {
      await login(`${inventada}, ${IP_ATACANTE}`).expect(429);
    }
  });
});
