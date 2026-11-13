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

interface Item {
  id: string;
  status: string;
  requesterEmail?: string;
  slaSummary?: { state: string; dueAt?: string; since?: string };
}

const PASSWORD = 'un-password-seguro';

describe('Datos de la bandeja (e2e, UX 2026-11-13)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  const run = randomUUID().slice(0, 8);
  let acme: Organizacion;
  let agente: string;
  let viewer: string;

  const claimsDe = (accessToken: string): { sub: string; tenantId: string } =>
    JSON.parse(
      Buffer.from(accessToken.split('.')[1], 'base64url').toString('utf8'),
    ) as { sub: string; tenantId: string };

  const conAuth = (
    metodo: 'get' | 'post' | 'patch',
    ruta: string,
    token: string,
  ) =>
    request(app.getHttpServer())
      [metodo](ruta)
      .set('Authorization', `Bearer ${token}`);

  const tokenConRol = async (role: Role): Promise<string> => {
    await prisma.withTenant(acme.tenantId, (tx) =>
      tx.membership.updateMany({
        where: { userId: acme.userId, tenantId: acme.tenantId },
        data: { role },
      }),
    );
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        organizationSlug: acme.slug,
        email: acme.email,
        password: PASSWORD,
      })
      .expect(200);
    return (res.body as { accessToken: string }).accessToken;
  };

  const crearTicket = async (subject: string) => {
    const res = await conAuth('post', '/tickets', acme.token)
      .send({ subject, description: 'Detalle.' })
      .expect(201);
    return (res.body as { id: string }).id;
  };

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);

    const nombre = `acme-ux-${run}`;
    const email = `ana@${nombre}.test`;
    const res = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ organizationName: nombre, email, password: PASSWORD })
      .expect(201);
    const token = (res.body as { accessToken: string }).accessToken;
    const claims = claimsDe(token);
    acme = {
      slug: nombre,
      email,
      tenantId: claims.tenantId,
      userId: claims.sub,
      token,
    };
    agente = await tokenConRol('AGENT');
    viewer = await tokenConRol('VIEWER');
    await tokenConRol('ADMIN');
  });

  afterAll(async () => {
    await prisma.withTenant(acme.tenantId, (tx) =>
      tx.organization.deleteMany({ where: { id: acme.tenantId } }),
    );
    await app.close();
  });

  it('el equipo recibe el email del solicitante y el resumen de SLA; el cliente no', async () => {
    const id = await crearTicket(`Con SLA ${run}`);
    // Un reloj corriendo, como lo dejaría el worker al crear el ticket.
    await prisma.withTenant(acme.tenantId, (tx) =>
      tx.slaTimer.create({
        data: {
          id: randomUUID(),
          tenantId: acme.tenantId,
          ticketId: id,
          kind: 'RESOLUTION',
          startedAt: new Date(),
          dueAt: new Date(Date.now() + 2 * 60 * 60 * 1000),
        },
      }),
    );

    const delEquipo = await conAuth('get', '/tickets', agente).expect(200);
    const fila = (delEquipo.body as { items: Item[] }).items.find(
      (t) => t.id === id,
    );
    expect(fila?.requesterEmail).toBe(acme.email);
    expect(fila?.slaSummary?.state).toBe('running');
    expect(fila?.slaSummary?.dueAt).toBeDefined();

    const delCliente = await conAuth('get', '/tickets', viewer).expect(200);
    for (const item of (delCliente.body as { items: object[] }).items) {
      expect(item).not.toHaveProperty('requesterEmail');
      expect(item).not.toHaveProperty('slaSummary');
    }
  });

  it('cada pestaña cuenta lo mismo que muestra, búsqueda incluida', async () => {
    const clave = `cuenta${run}`;
    const ids = [
      await crearTicket(`${clave} uno`),
      await crearTicket(`${clave} dos`),
      await crearTicket(`${clave} tres`),
    ];
    await conAuth('patch', `/tickets/${ids[0]}/status`, agente)
      .send({ status: 'IN_PROGRESS' })
      .expect(200);

    const res = await conAuth(
      'get',
      `/tickets/counts?q=${clave}`,
      agente,
    ).expect(200);
    const counts = res.body as Record<string, number>;
    expect(counts).toEqual({
      OPEN: 2,
      IN_PROGRESS: 1,
      WAITING_ON_CUSTOMER: 0,
      RESOLVED: 0,
      CLOSED: 0,
    });

    const enCurso = await conAuth(
      'get',
      `/tickets?q=${clave}&status=IN_PROGRESS`,
      agente,
    ).expect(200);
    expect((enCurso.body as { items: Item[] }).items).toHaveLength(
      counts.IN_PROGRESS,
    );
  });

  it('el cliente no puede contar por etiqueta (como el listado)', async () => {
    await conAuth(
      'get',
      `/tickets/counts?tagId=${randomUUID()}`,
      viewer,
    ).expect(403);
  });

  it('sin servicio de IA configurado, el triage dice "disabled", no "pending"', async () => {
    const id = await crearTicket(`Sin IA ${run}`);

    const res = await conAuth('get', `/tickets/${id}/triage`, agente).expect(
      200,
    );

    expect(res.body).toEqual({ status: 'disabled' });
  });
});
