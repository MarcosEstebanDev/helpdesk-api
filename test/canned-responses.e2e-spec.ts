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
  /** Token de ADMIN (quien registra la organización es ADMIN). */
  token: string;
}

interface Plantilla {
  id: string;
  title: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

const PASSWORD = 'un-password-seguro';

describe('Respuestas predefinidas (e2e, ADR-0030)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  const run = randomUUID().slice(0, 8);
  let acme: Organizacion;
  /** Segunda organización: sus plantillas no pueden alcanzar a la primera. */
  let otra: Organizacion;
  let agente: string;
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

  /** Cambia el rol en la base y vuelve a entrar: el rol viaja en el token. */
  const tokenConRol = async (
    org: Organizacion,
    role: Role,
  ): Promise<string> => {
    await prisma.withTenant(org.tenantId, (tx) =>
      tx.membership.updateMany({
        where: { userId: org.userId, tenantId: org.tenantId },
        data: { role },
      }),
    );
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        organizationSlug: org.slug,
        email: org.email,
        password: PASSWORD,
      })
      .expect(200);
    return (res.body as { accessToken: string }).accessToken;
  };

  // Sin `async`: devuelve el encadenable de supertest.
  const conAuth = (
    metodo: 'get' | 'post' | 'put' | 'delete',
    ruta: string,
    token: string,
  ) =>
    request(app.getHttpServer())
      [metodo](ruta)
      .set('Authorization', `Bearer ${token}`);

  const crear = (token: string, title: string, body: string) =>
    conAuth('post', '/canned-responses', token).send({ title, body });

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);

    acme = await registrar(`acme-cr-${run}`);
    otra = await registrar(`otra-cr-${run}`);
    // El token de ADMIN de `acme` sigue valiendo: el rol va en el token.
    agente = await tokenConRol(acme, 'AGENT');
    viewer = await tokenConRol(acme, 'VIEWER');
  });

  afterAll(async () => {
    for (const org of [acme, otra]) {
      await prisma.withTenant(org.tenantId, (tx) =>
        tx.organization.deleteMany({ where: { id: org.tenantId } }),
      );
    }
    await app.close();
  });

  it('el ADMIN la crea y el agente la ve en el listado', async () => {
    const res = await crear(
      acme.token,
      'Saludo',
      'Hola! Ya estamos con el ticket {{ticket.numero}}.',
    ).expect(201);
    const creada = res.body as Plantilla;
    expect(creada.title).toBe('Saludo');

    const lista = await conAuth('get', '/canned-responses', agente).expect(200);
    const items = (lista.body as { items: Plantilla[] }).items;
    expect(items.map((p) => p.id)).toContain(creada.id);
  });

  it('el cliente no puede ni listarlas', async () => {
    await conAuth('get', '/canned-responses', viewer).expect(403);
  });

  it('un agente no puede crearlas', async () => {
    await crear(agente, 'Del agente', 'Hola').expect(403);
  });

  it('una llave sin cerrar es un 400 que dice qué está mal', async () => {
    const res = await crear(acme.token, 'Rota', 'Hola {{ticket.numero').expect(
      400,
    );
    expect((res.body as { code: string }).code).toBe(
      'ticketing.invalid_canned_response',
    );
  });

  it('un título repetido con otras mayúsculas es un 409', async () => {
    await crear(acme.token, 'Despedida', 'Chau').expect(201);
    await crear(acme.token, 'DESPEDIDA', 'Chau otra vez').expect(409);
  });

  it('editar y borrar dejan rastro en la auditoría', async () => {
    const res = await crear(acme.token, 'Pedir datos', 'Necesitamos más info');
    const { id } = res.body as Plantilla;

    const editada = await conAuth('put', `/canned-responses/${id}`, acme.token)
      .send({ title: 'Pedir datos', body: '¿Nos pasás una captura?' })
      .expect(200);
    expect((editada.body as Plantilla).body).toBe('¿Nos pasás una captura?');

    await conAuth('delete', `/canned-responses/${id}`, acme.token).expect(204);

    const lista = await conAuth('get', '/canned-responses', agente).expect(200);
    const ids = (lista.body as { items: Plantilla[] }).items.map((p) => p.id);
    expect(ids).not.toContain(id);

    const acciones = await prisma.withTenant(acme.tenantId, (tx) =>
      tx.auditLog.findMany({
        where: { entityType: 'CannedResponse', entityId: id },
        orderBy: { occurredAt: 'asc' },
        select: { action: true },
      }),
    );
    expect(acciones.map((a) => a.action)).toEqual([
      'canned_response.created',
      'canned_response.updated',
      'canned_response.deleted',
    ]);
  });

  it('otra organización no la ve ni la puede tocar', async () => {
    const res = await crear(acme.token, 'Privada', 'Solo de acme');
    const { id } = res.body as Plantilla;

    const lista = await conAuth('get', '/canned-responses', otra.token).expect(
      200,
    );
    const ids = (lista.body as { items: Plantilla[] }).items.map((p) => p.id);
    expect(ids).not.toContain(id);

    await conAuth('put', `/canned-responses/${id}`, otra.token)
      .send({ title: 'Robada', body: 'x' })
      .expect(404);
    await conAuth('delete', `/canned-responses/${id}`, otra.token).expect(404);
  });

  it('un título que solo pasa de 80 por los espacios de los bordes se acepta', async () => {
    const titulo = 't'.repeat(80);

    const res = await crear(acme.token, `  ${titulo}  `, 'Hola').expect(201);

    expect((res.body as Plantilla).title).toBe(titulo);
  });
});
