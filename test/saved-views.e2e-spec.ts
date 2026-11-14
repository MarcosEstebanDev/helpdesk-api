import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import { Role } from '../src/modules/iam/domain/role';

process.env.THROTTLE_SKIP = '1';

interface Organizacion {
  slug: string;
  email: string;
  tenantId: string;
  userId: string;
  token: string;
}

interface Vista {
  id: string;
  name: string;
  shared: boolean;
  filters: Record<string, unknown>;
}

const PASSWORD = 'un-password-seguro';

describe('Vistas guardadas (e2e, ADR-0033)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  const run = randomUUID().slice(0, 8);
  let acme: Organizacion;
  let otra: Organizacion;
  /** Otra persona del equipo de acme, con su propio usuario. */
  let beto: Organizacion;
  let admin: string;
  let agente: string;
  let agenteBeto: string;
  /** Beto como ADMIN: un administrador que NO es dueño de las vistas de Ana. */
  let adminBeto: string;
  let viewer: string;

  const claimsDe = (accessToken: string): { sub: string; tenantId: string } =>
    JSON.parse(
      Buffer.from(accessToken.split('.')[1], 'base64url').toString('utf8'),
    ) as { sub: string; tenantId: string };

  const registrar = async (nombre: string): Promise<Organizacion> => {
    const email = `ana@${nombre}.test`;
    const res = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ organizationName: nombre, email, password: PASSWORD })
      .expect(201);
    const token = (res.body as { accessToken: string }).accessToken;
    const claims = claimsDe(token);
    return {
      slug: nombre,
      email,
      tenantId: claims.tenantId,
      userId: claims.sub,
      token,
    };
  };

  const login = async (org: Organizacion, email: string): Promise<string> => {
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ organizationSlug: org.slug, email, password: PASSWORD })
      .expect(200);
    return (res.body as { accessToken: string }).accessToken;
  };

  const ponerRol = (org: Organizacion, userId: string, role: Role) =>
    prisma.withTenant(org.tenantId, (tx) =>
      tx.membership.updateMany({
        where: { userId, tenantId: org.tenantId },
        data: { role },
      }),
    );

  const conAuth = (
    metodo: 'get' | 'post' | 'put' | 'delete',
    ruta: string,
    token: string,
  ) =>
    request(app.getHttpServer())
      [metodo](ruta)
      .set('Authorization', `Bearer ${token}`);

  const crear = (
    token: string,
    name: string,
    filters: object,
    shared = false,
  ) => conAuth('post', '/views', token).send({ name, filters, shared });

  const nombres = async (token: string) => {
    const res = await conAuth('get', '/views', token).expect(200);
    return (res.body as { items: Vista[] }).items.map((v) => v.name);
  };

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);

    acme = await registrar(`acme-v-${run}`);
    otra = await registrar(`otra-v-${run}`);
    admin = acme.token;

    // Una segunda persona en acme: se crea su usuario y su membresía a mano,
    // como hace el seed (no hay caso de uso de invitación).
    const hash = await prisma.withTenant(acme.tenantId, async (tx) => {
      const ana = await tx.user.findFirstOrThrow({
        where: { tenantId: acme.tenantId },
      });
      return ana.passwordHash;
    });
    const betoId = randomUUID();
    const betoEmail = `beto@acme-v-${run}.test`;
    await prisma.withTenant(acme.tenantId, async (tx) => {
      await tx.user.create({
        data: {
          id: betoId,
          tenantId: acme.tenantId,
          email: betoEmail,
          passwordHash: hash,
        },
      });
      await tx.membership.create({
        data: {
          id: randomUUID(),
          tenantId: acme.tenantId,
          userId: betoId,
          role: 'AGENT',
        },
      });
    });
    beto = { ...acme, email: betoEmail, userId: betoId };
    agenteBeto = await login(acme, betoEmail);
    await ponerRol(acme, betoId, 'ADMIN');
    adminBeto = await login(acme, betoEmail);
    await ponerRol(acme, betoId, 'AGENT');

    // Ana como AGENT y como VIEWER (el token de ADMIN sigue valiendo).
    await ponerRol(acme, acme.userId, 'AGENT');
    agente = await login(acme, acme.email);
    await ponerRol(acme, acme.userId, 'VIEWER');
    viewer = await login(acme, acme.email);
    await ponerRol(acme, acme.userId, 'ADMIN');
  });

  afterAll(async () => {
    for (const org of [acme, otra]) {
      await prisma.withTenant(org.tenantId, (tx) =>
        tx.organization.deleteMany({ where: { id: org.tenantId } }),
      );
    }
    await app.close();
  });

  it('un agente guarda una vista personal y solo él la ve', async () => {
    const res = await crear(agente, 'Mis urgentes', {
      version: 1,
      assignee: 'me',
      status: 'IN_PROGRESS',
    }).expect(201);
    expect((res.body as Vista).shared).toBe(false);

    expect(await nombres(agente)).toContain('Mis urgentes');
    expect(await nombres(agenteBeto)).not.toContain('Mis urgentes');
  });

  it('un ADMIN comparte una vista y la ve todo el equipo', async () => {
    await crear(
      admin,
      'Sin asignar',
      { version: 1, status: 'OPEN' },
      true,
    ).expect(201);

    expect(await nombres(agenteBeto)).toContain('Sin asignar');
  });

  it('un agente no crea compartidas', async () => {
    await crear(agente, 'Para todos', { version: 1 }, true).expect(403);
  });

  it('el cliente no usa vistas', async () => {
    await conAuth('get', '/views', viewer).expect(403);
  });

  it('filtros inválidos son un 400 que nombra el campo', async () => {
    for (const filters of [
      { version: 1, priority: 'HIGH' },
      { version: 1, assignee: beto.userId },
      { version: 2 },
      {
        version: 1,
        tagIds: Array.from({ length: 11 }, () => randomUUID()),
      },
    ]) {
      const res = await crear(agente, `Rota ${run}`, filters).expect(400);
      expect((res.body as { code: string }).code).toBe(
        'ticketing.invalid_saved_view',
      );
    }
  });

  it('el mismo nombre personal en dos personas sí; dos compartidas iguales no', async () => {
    await crear(agenteBeto, 'Mis urgentes', { version: 1 }).expect(201);
    await crear(admin, 'SIN ASIGNAR', { version: 1 }, true).expect(409);
  });

  it('nadie toca la vista personal de otro: 404, aunque sea ADMIN', async () => {
    const res = await crear(agente, 'Privada', { version: 1 }).expect(201);
    const { id } = res.body as Vista;

    await conAuth('put', `/views/${id}`, agenteBeto)
      .send({ name: 'Robada', filters: { version: 1 } })
      .expect(404);
    // `admin` es Ana con otro rol (la dueña); el ADMIN ajeno es Beto.
    await conAuth('delete', `/views/${id}`, adminBeto).expect(404);
    expect(await nombres(agente)).toContain('Privada');
  });

  it('un agente no edita ni borra una compartida; el ADMIN sí', async () => {
    const res = await crear(admin, 'Cola común', { version: 1 }, true).expect(
      201,
    );
    const { id } = res.body as Vista;

    await conAuth('put', `/views/${id}`, agente)
      .send({ name: 'Cambiada', filters: { version: 1 } })
      .expect(403);
    await conAuth('delete', `/views/${id}`, agente).expect(403);
    // Los 403 no cambiaron nada.
    expect(await nombres(agente)).toContain('Cola común');

    await conAuth('put', `/views/${id}`, admin)
      .send({
        name: 'Cola del equipo',
        filters: { version: 1, status: 'OPEN' },
      })
      .expect(200);
    await conAuth('delete', `/views/${id}`, admin).expect(204);
    expect(await nombres(agente)).not.toContain('Cola del equipo');
  });

  it('otra organización no ve nada de acá', async () => {
    expect(await nombres(otra.token)).toEqual([]);
  });
});
