import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import { LOGIN_THROTTLE } from '../src/modules/iam/infrastructure/http/throttle.policy';

// Explícito: esta suite corre con el guard REAL, pase lo que pase.
delete process.env.THROTTLE_SKIP;

/**
 * Verifica la política de rate limiting de autenticación (ADR-0013).
 *
 * Suite separada de `auth-flow.e2e-spec.ts` a propósito: aquella activa
 * `THROTTLE_SKIP` para poder encadenar logins, así que si el límite se rompiera
 * no se enteraría nadie. Esta corre con el guard REAL.
 *
 * El almacenamiento del throttler es en memoria y por proceso, así que cada
 * suite arranca con los contadores a cero.
 */
describe('Auth rate limiting (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  const run = randomUUID().slice(0, 8);
  const orgSlug = `ratelimit-${run}`;
  const email = `ana@ratelimit-${run}.test`;
  const password = 'un-password-seguro';

  let tenantId: string;

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
      .send({ organizationName: `Ratelimit ${run}`, email, password })
      .expect(201);

    const { accessToken } = res.body as { accessToken: string };
    const claims = Buffer.from(accessToken.split('.')[1], 'base64url').toString(
      'utf8',
    );
    tenantId = (JSON.parse(claims) as { tenantId: string }).tenantId;
  });

  afterAll(async () => {
    await prisma.withTenant(tenantId, (tx) =>
      tx.organization.deleteMany({ where: { id: tenantId } }),
    );
    await app.close();
  });

  it('corta los intentos de login tras alcanzar el límite', async () => {
    const attempt = () =>
      request(app.getHttpServer())
        .post('/auth/login')
        .send({ organizationSlug: orgSlug, email, password: 'incorrecto' });

    // El registro del beforeAll no cuenta: cada ruta lleva su propio contador.
    const statuses: number[] = [];
    for (let i = 0; i < LOGIN_THROTTLE.limit; i++) {
      statuses.push((await attempt()).status);
    }

    // Hasta el límite, credenciales inválidas: el endpoint responde con normalidad.
    expect(statuses).toEqual(
      Array.from({ length: LOGIN_THROTTLE.limit }, () => 401),
    );

    // El siguiente ya no llega al caso de uso: lo corta el guard.
    const blocked = await attempt();
    expect(blocked.status).toBe(429);
  });

  it('el bloqueo protege también a las credenciales CORRECTAS', async () => {
    // Comprobación deliberada: un atacante que agota el límite deja fuera al
    // usuario legítimo. Es el coste conocido de limitar por IP+ruta, y está
    // registrado como consecuencia en el ADR-0013. Si algún día se limita por
    // cuenta en vez de por IP, este test es el que debe cambiar.
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ organizationSlug: orgSlug, email, password });

    expect(res.status).toBe(429);
  });

  it('no afecta a rutas ajenas a la política estricta', async () => {
    await request(app.getHttpServer()).get('/health').expect(200);
  });
});
