import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import { Role } from '../src/modules/iam/domain/role';
import { CLOCK, Clock } from '../src/shared-kernel';

process.env.THROTTLE_SKIP = '1';

const PASSWORD = 'un-password-seguro';
// Sábado 14/11/2026 10:00 en Argentina (UTC-3).
const SABADO = new Date('2026-11-14T13:00:00.000Z');

describe('Horario laboral por HTTP (e2e, ADR-0034)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const reloj: Clock & { ahora: Date } = {
    ahora: SABADO,
    now() {
      return this.ahora;
    },
  };

  const run = randomUUID().slice(0, 8);
  const nombre = `acme-bh-${run}`;
  const email = `ana@${nombre}.test`;
  let tenantId = '';
  let userId = '';
  let admin = '';
  let agente = '';
  let viewer = '';

  const http = () => request(app.getHttpServer());
  const como = (token: string) => ({
    get: (r: string) => http().get(r).set('Authorization', `Bearer ${token}`),
    put: (r: string) => http().put(r).set('Authorization', `Bearer ${token}`),
    post: (r: string) => http().post(r).set('Authorization', `Bearer ${token}`),
    del: (r: string) =>
      http().delete(r).set('Authorization', `Bearer ${token}`),
  });

  const tokenConRol = async (role: Role): Promise<string> => {
    await prisma.withTenant(tenantId, (tx) =>
      tx.membership.updateMany({ where: { userId, tenantId }, data: { role } }),
    );
    const res = await http()
      .post('/auth/login')
      .send({ organizationSlug: nombre, email, password: PASSWORD })
      .expect(200);
    return (res.body as { accessToken: string }).accessToken;
  };

  const auditadas = () =>
    prisma.withTenant(tenantId, (tx) =>
      tx.auditLog.count({
        where: { tenantId, action: 'business_hours.changed' },
      }),
    );

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(CLOCK)
      .useValue(reloj)
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);

    const res = await http()
      .post('/auth/register')
      .send({ organizationName: nombre, email, password: PASSWORD })
      .expect(201);
    const token = (res.body as { accessToken: string }).accessToken;
    const claims = JSON.parse(
      Buffer.from(token.split('.')[1], 'base64url').toString('utf8'),
    ) as { sub: string; tenantId: string };
    tenantId = claims.tenantId;
    userId = claims.sub;
    agente = await tokenConRol('AGENT');
    viewer = await tokenConRol('VIEWER');
    admin = await tokenConRol('ADMIN');
  });

  afterAll(async () => {
    await prisma.withTenant(tenantId, (tx) =>
      tx.organization.deleteMany({ where: { id: tenantId } }),
    );
    await app.close();
  });

  it('configurar es solo del ADMIN', async () => {
    for (const token of [agente, viewer]) {
      await como(token).get('/business-hours').expect(403);
      await como(token).put('/business-hours').send({}).expect(403);
      await como(token).post('/business-hours/exceptions').send({}).expect(403);
      await como(token).post('/business-hours/holidays/2026').expect(403);
      await como(token)
        .del(`/business-hours/exceptions/${randomUUID()}`)
        .expect(403);
    }
  });

  it('sin configurar rige el horario por defecto', async () => {
    const res = await como(admin).get('/business-hours').expect(200);
    expect(res.body).toEqual({
      mode: 'business_hours',
      timeZone: 'America/Argentina/Buenos_Aires',
      weekdays: [1, 2, 3, 4, 5],
      opensAt: '08:00',
      closesAt: '18:00',
      source: 'default',
      exceptions: [],
    });
  });

  it('un sábado el cliente ve "cerrado" y cuándo abre, y NADA más', async () => {
    const res = await como(viewer).get('/business-hours/status').expect(200);
    expect(res.body).toEqual({
      open: false,
      nextOpening: '2026-11-16T11:00:00.000Z',
      timeZone: 'America/Argentina/Buenos_Aires',
    });
  });

  it('un horario imposible da 400 con su código y no se guarda', async () => {
    const res = await como(admin)
      .put('/business-hours')
      .send({
        mode: 'business_hours',
        timeZone: 'America/Argentina/Buenos_Aires',
        weekdays: [],
        opensAt: '08:00',
        closesAt: '18:00',
      })
      .expect(400);
    expect((res.body as { code: string }).code).toBe(
      'ticketing.invalid_business_hours',
    );
    expect(
      ((await como(admin).get('/business-hours')).body as { source: string })
        .source,
    ).toBe('default');
  });

  it('guarda la semana, la audita, y en 24/7 el cliente ve "abierto"', async () => {
    const antes = await auditadas();
    await como(admin)
      .put('/business-hours')
      .send({
        mode: '24_7',
        timeZone: 'America/Argentina/Buenos_Aires',
        weekdays: [1, 2, 3, 4, 5],
        opensAt: '09:00',
        closesAt: '17:00',
      })
      .expect(200);
    expect(await auditadas()).toBe(antes + 1);
    const res = await como(viewer).get('/business-hours/status').expect(200);
    expect(res.body).toMatchObject({ open: true, nextOpening: null });
  });

  it('feriados: la segunda carga no agrega nada, y fuera de rango es 400', async () => {
    const primera = await como(admin)
      .post('/business-hours/holidays/2026')
      .expect(200);
    expect((primera.body as { added: number }).added).toBeGreaterThan(10);
    const segunda = await como(admin)
      .post('/business-hours/holidays/2026')
      .expect(200);
    expect(segunda.body).toMatchObject({ added: 0 });
    await como(admin).post('/business-hours/holidays/2030').expect(400);
  });

  it('una excepción se agrega, choca con 409 si se repite, y se borra', async () => {
    const res = await como(admin)
      .post('/business-hours/exceptions')
      .send({ date: '2026-12-31', working: false, name: 'Cierre de año' })
      .expect(201);
    const id = (res.body as { id: string }).id;
    await como(admin)
      .post('/business-hours/exceptions')
      .send({ date: '2026-12-31', working: true, name: 'Otra' })
      .expect(409);
    await como(admin).del(`/business-hours/exceptions/${id}`).expect(204);
    await como(admin).del(`/business-hours/exceptions/${id}`).expect(404);
  });
});
