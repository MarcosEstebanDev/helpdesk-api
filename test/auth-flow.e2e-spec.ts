import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';

// Esta suite ejercita el FLUJO, no la política de rate limiting: encadena varios
// logins que dispararían el límite (ADR-0013). El límite tiene su propia suite,
// `auth-rate-limit.e2e-spec.ts`, que corre con el guard real.
// Jest aísla cada suite en su proceso, así que esto no afecta a la otra.
process.env.THROTTLE_SKIP = '1';

/**
 * Test e2e del flujo completo de autenticación (Fase 2c, ADR-0011).
 *
 * Cubre lo que los tests unitarios NO pueden: que el cableado de Nest, RLS,
 * argon2, los JWT y las cookies funcionen juntos contra una base de datos real.
 */
describe('Auth flow (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  /** Sufijo único por corrida: evita colisiones de slug entre ejecuciones. */
  const run = randomUUID().slice(0, 8);
  const orgName = `Acme ${run}`;
  const orgSlug = `acme-${run}`;
  const email = `ana@acme-${run}.test`;
  const password = 'un-password-seguro';

  const createdTenants: string[] = [];

  /** Extrae el par `nombre=valor` de la cookie de refresh de una respuesta. */
  const refreshCookie = (res: request.Response): string => {
    const raw = res.headers['set-cookie'] as unknown as string[] | undefined;
    const cookie = raw?.find((c) => c.startsWith('refresh_token='));
    if (cookie === undefined) {
      throw new Error('La respuesta no trae cookie refresh_token.');
    }
    return cookie.split(';')[0];
  };

  const decodeTenantId = (accessToken: string): string => {
    const payload = accessToken.split('.')[1];
    const json = Buffer.from(payload, 'base64url').toString('utf8');
    return (JSON.parse(json) as { tenantId: string }).tenantId;
  };

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    configureApp(app); // el MISMO pipeline que producción
    await app.init();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    for (const tenantId of createdTenants) {
      await prisma.withTenant(tenantId, (tx) =>
        tx.organization.deleteMany({ where: { id: tenantId } }),
      );
    }
    await app.close();
  });

  // ---------------------------------------------------------------- registro

  it('registra una organización y devuelve sesión iniciada', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ organizationName: orgName, email, password })
      .expect(201);

    const body = res.body as { accessToken: string };
    expect(typeof body.accessToken).toBe('string');
    createdTenants.push(decodeTenantId(body.accessToken));

    const cookies = res.headers['set-cookie'] as unknown as string[];
    const refresh = cookies.find((c) => c.startsWith('refresh_token='));
    expect(refresh).toContain('HttpOnly'); // inaccesible desde JS
    expect(refresh).toContain('Path=/auth'); // acotada a los endpoints de auth
  });

  it('rechaza registrar una organización con nombre ya usado', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ organizationName: orgName, email: 'otro@acme.test', password })
      .expect(409);

    expect((res.body as { code: string }).code).toBe(
      'iam.organization_name_taken',
    );
  });

  it('rechaza un password que no cumple la política', async () => {
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ organizationName: `X ${run}`, email, password: 'corto' })
      .expect(400);
  });

  // ------------------------------------------------------------------- login

  it('inicia sesión con credenciales correctas', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ organizationSlug: orgSlug, email, password })
      .expect(200);

    expect(typeof (res.body as { accessToken: string }).accessToken).toBe(
      'string',
    );
  });

  it('devuelve el MISMO error ante password, email y slug inválidos', async () => {
    const codes: string[] = [];

    for (const payload of [
      { organizationSlug: orgSlug, email, password: 'password-incorrecto' },
      { organizationSlug: orgSlug, email: 'nadie@acme.test', password },
      { organizationSlug: `no-existe-${run}`, email, password },
    ]) {
      const res = await request(app.getHttpServer())
        .post('/auth/login')
        .send(payload)
        .expect(401);
      codes.push((res.body as { code: string }).code);
    }

    // Anti-enumeración: si los errores difirieran, un atacante podría descubrir
    // qué organizaciones y qué emails existen probando combinaciones.
    expect(new Set(codes)).toEqual(new Set(['iam.invalid_credentials']));
  });

  // ---------------------------------------------------------------------- me

  it('GET /auth/me devuelve el principal autenticado', async () => {
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ organizationSlug: orgSlug, email, password })
      .expect(200);

    const { accessToken } = login.body as { accessToken: string };

    const res = await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    expect(res.body).toMatchObject({
      role: 'ADMIN',
      tenantId: decodeTenantId(accessToken),
    });
  });

  /**
   * El email NO viaja en el token: se lee de la base (ADR-0025, decisión 5).
   * Sin esto, el cliente se quedaba sin email en cuanto recargaba la página.
   */
  it('GET /auth/me devuelve el email del usuario autenticado', async () => {
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ organizationSlug: orgSlug, email, password })
      .expect(200);

    const { accessToken } = login.body as { accessToken: string };

    const res = await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    expect((res.body as { email: string }).email).toBe(email);
  });

  /**
   * La reproducción exacta del bug: el access token vive solo en memoria, así
   * que una recarga de página empieza canjeando el refresh y llamando a
   * `/auth/me`. Si por ese camino no viniera el email, el usuario quedaría con
   * el email vacío hasta el siguiente login.
   */
  it('tras refrescar la sesión, /auth/me sigue devolviendo el email', async () => {
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ organizationSlug: orgSlug, email, password })
      .expect(200);

    const cookies = login.get('Set-Cookie') ?? [];

    const refresh = await request(app.getHttpServer())
      .post('/auth/refresh')
      .set('Cookie', cookies)
      .expect(200);

    const { accessToken } = refresh.body as { accessToken: string };

    const res = await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    expect((res.body as { email: string }).email).toBe(email);
  });

  /**
   * Fija la decisión 5 del ADR-0025: el `role` sale del TOKEN aunque el email
   * se lea de la base. Devolver un rol fresco haría que `/auth/me` contradijera
   * a los guards, que autorizan comparando contra el rol del token.
   */
  it('el rol de /auth/me es el del TOKEN, no el de la base de datos', async () => {
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ organizationSlug: orgSlug, email, password })
      .expect(200);

    const { accessToken } = login.body as { accessToken: string };
    const tenantId = decodeTenantId(accessToken);

    // Se degrada el rol en la base SIN volver a hacer login.
    await prisma.withTenant(tenantId, (tx) =>
      tx.membership.updateMany({
        where: { tenantId },
        data: { role: 'VIEWER' },
      }),
    );

    const res = await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    expect((res.body as { role: string }).role).toBe('ADMIN');

    await prisma.withTenant(tenantId, (tx) =>
      tx.membership.updateMany({
        where: { tenantId },
        data: { role: 'ADMIN' },
      }),
    );
  });

  it('GET /auth/me sin token devuelve 401', async () => {
    await request(app.getHttpServer()).get('/auth/me').expect(401);
  });

  it('GET /auth/me con token manipulado devuelve 401', async () => {
    await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', 'Bearer no.es.un.jwt')
      .expect(401);
  });

  // ------------------------------------------------------- rotación y reuse

  it('rota el refresh token y emite un access nuevo', async () => {
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ organizationSlug: orgSlug, email, password })
      .expect(200);

    const first = refreshCookie(login);

    const refreshed = await request(app.getHttpServer())
      .post('/auth/refresh')
      .set('Cookie', first)
      .expect(200);

    const second = refreshCookie(refreshed);
    expect(second).not.toEqual(first); // rotó de verdad
    expect(typeof (refreshed.body as { accessToken: string }).accessToken).toBe(
      'string',
    );
  });

  it('detecta el reuse de un refresh rotado y revoca la familia entera', async () => {
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ organizationSlug: orgSlug, email, password })
      .expect(200);

    const first = refreshCookie(login);

    const refreshed = await request(app.getHttpServer())
      .post('/auth/refresh')
      .set('Cookie', first)
      .expect(200);
    const second = refreshCookie(refreshed);

    // Presentar el viejo es la señal de robo.
    const reuse = await request(app.getHttpServer())
      .post('/auth/refresh')
      .set('Cookie', first)
      .expect(401);
    expect((reuse.body as { code: string }).code).toBe(
      'iam.refresh_token_reuse',
    );

    // Y el token legítimo también muere: la familia completa quedó revocada.
    await request(app.getHttpServer())
      .post('/auth/refresh')
      .set('Cookie', second)
      .expect(401);
  });

  // ------------------------------------------------------------------ logout

  it('logout revoca la sesión y es idempotente', async () => {
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ organizationSlug: orgSlug, email, password })
      .expect(200);

    const cookie = refreshCookie(login);

    await request(app.getHttpServer())
      .post('/auth/logout')
      .set('Cookie', cookie)
      .expect(204);

    await request(app.getHttpServer())
      .post('/auth/refresh')
      .set('Cookie', cookie)
      .expect(401);

    // Repetir el logout no es un error: no hay nada que revocar.
    await request(app.getHttpServer())
      .post('/auth/logout')
      .set('Cookie', cookie)
      .expect(204);
  });

  // ------------------------------------------------ aislamiento entre tenants

  it('un usuario no puede iniciar sesión en otra organización', async () => {
    const otherSlug = `globex-${run}`;

    const other = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        organizationName: `Globex ${run}`,
        email: `carla@globex-${run}.test`,
        password,
      })
      .expect(201);
    createdTenants.push(
      decodeTenantId((other.body as { accessToken: string }).accessToken),
    );

    // El email existe... pero en OTRO tenant. El email es único por tenant.
    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ organizationSlug: otherSlug, email, password })
      .expect(401);
  });
});
