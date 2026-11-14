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

interface Etiqueta {
  id: string;
  name: string;
  color: string;
}

const PASSWORD = 'un-password-seguro';

describe('Etiquetas (e2e, ADR-0031)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  const run = randomUUID().slice(0, 8);
  let acme: Organizacion;
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

  const conAuth = (
    metodo: 'get' | 'post' | 'put' | 'patch' | 'delete',
    ruta: string,
    token: string,
  ) =>
    request(app.getHttpServer())
      [metodo](ruta)
      .set('Authorization', `Bearer ${token}`);

  const crearEtiqueta = async (name: string, color?: string) => {
    const res = await conAuth('post', '/tags', agente)
      .send({ name, ...(color ? { color } : {}) })
      .expect(201);
    return res.body as Etiqueta;
  };

  const crearTicket = async (subject: string) => {
    const res = await conAuth('post', '/tickets', acme.token)
      .send({ subject, description: 'Detalle del problema.' })
      .expect(201);
    return (res.body as { id: string }).id;
  };

  const etiquetar = (ticketId: string, tagIds: string[], token = agente) =>
    conAuth('put', `/tickets/${ticketId}/tags`, token).send({ tagIds });

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);

    acme = await registrar(`acme-tag-${run}`);
    otra = await registrar(`otra-tag-${run}`);
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

  it('un agente crea etiquetas; un nombre repetido es 409', async () => {
    const bug = await crearEtiqueta('Bug', 'red');
    expect(bug.color).toBe('red');

    await conAuth('post', '/tags', agente).send({ name: 'BUG' }).expect(409);

    const lista = await conAuth('get', '/tags', agente).expect(200);
    const nombres = (lista.body as { items: Etiqueta[] }).items.map(
      (t) => t.name,
    );
    expect(nombres).toContain('Bug');
  });

  it('el cliente no ve el catálogo', async () => {
    await conAuth('get', '/tags', viewer).expect(403);
  });

  it('etiquetar un ticket lo muestra al equipo y emite el evento', async () => {
    const vip = await crearEtiqueta('VIP', 'purple');
    const ticketId = await crearTicket('Etiquetado');

    const res = await etiquetar(ticketId, [vip.id]).expect(200);
    expect((res.body as { tags: Etiqueta[] }).tags.map((t) => t.id)).toEqual([
      vip.id,
    ]);

    const detalle = await conAuth('get', `/tickets/${ticketId}`, agente).expect(
      200,
    );
    expect((detalle.body as { tags: Etiqueta[] }).tags).toEqual([
      { id: vip.id, name: 'VIP', color: 'purple' },
    ]);

    const eventos = await prisma.withTenant(acme.tenantId, (tx) =>
      tx.outboxMessage.findMany({
        where: { aggregateId: ticketId, eventName: 'ticket.tags_changed' },
      }),
    );
    expect(eventos).toHaveLength(1);
  });

  it('al cliente no le llega la clave `tags` ni puede filtrar por etiqueta', async () => {
    const etiqueta = await crearEtiqueta('Interna');
    const ticketId = await crearTicket('Con etiqueta interna');
    await etiquetar(ticketId, [etiqueta.id]).expect(200);

    const detalle = await conAuth('get', `/tickets/${ticketId}`, viewer).expect(
      200,
    );
    expect(detalle.body).not.toHaveProperty('tags');

    const lista = await conAuth('get', '/tickets', viewer).expect(200);
    for (const item of (lista.body as { items: object[] }).items) {
      expect(item).not.toHaveProperty('tags');
    }

    await conAuth('get', `/tickets?tagId=${etiqueta.id}`, viewer).expect(403);
  });

  it('más de 10 etiquetas es un 400 y no cambia nada', async () => {
    const ticketId = await crearTicket('Demasiadas');
    const once = Array.from({ length: 11 }, () => randomUUID());

    await etiquetar(ticketId, once).expect(400);

    const detalle = await conAuth('get', `/tickets/${ticketId}`, agente).expect(
      200,
    );
    expect((detalle.body as { tags: Etiqueta[] }).tags).toEqual([]);
  });

  it('una etiqueta de otra organización es un 404 y no cambia nada', async () => {
    const ajena = await conAuth('post', '/tags', otra.token)
      .send({ name: 'Ajena' })
      .expect(201);
    const propia = await crearEtiqueta('Propia');
    const ticketId = await crearTicket('Sin ajenas');
    await etiquetar(ticketId, [propia.id]).expect(200);

    await etiquetar(ticketId, [(ajena.body as Etiqueta).id]).expect(404);

    const detalle = await conAuth('get', `/tickets/${ticketId}`, agente).expect(
      200,
    );
    expect(
      (detalle.body as { tags: Etiqueta[] }).tags.map((t) => t.id),
    ).toEqual([propia.id]);
  });

  it('el filtro trae tickets con al menos una, cada uno una vez', async () => {
    const a = await crearEtiqueta('Filtro A');
    const b = await crearEtiqueta('Filtro B');
    const conA = await crearTicket('Con A');
    const conAyB = await crearTicket('Con A y B');
    const sinNada = await crearTicket('Sin nada');
    await etiquetar(conA, [a.id]).expect(200);
    await etiquetar(conAyB, [a.id, b.id]).expect(200);

    const res = await conAuth(
      'get',
      `/tickets?tagId=${a.id}&tagId=${b.id}`,
      agente,
    ).expect(200);
    const ids = (res.body as { items: { id: string }[] }).items.map(
      (t) => t.id,
    );

    expect(ids.sort()).toEqual([conA, conAyB].sort());
    expect(ids).not.toContain(sinNada);
  });

  it('filtrar por una etiqueta que no existe devuelve vacío, no un error', async () => {
    const res = await conAuth(
      'get',
      `/tickets?tagId=${randomUUID()}`,
      agente,
    ).expect(200);
    expect((res.body as { items: unknown[] }).items).toEqual([]);
  });

  it('un ticket cerrado no se re-etiqueta', async () => {
    const etiqueta = await crearEtiqueta('Tarde');
    const ticketId = await crearTicket('Cerrado');
    await conAuth('patch', `/tickets/${ticketId}/status`, agente)
      .send({ status: 'RESOLVED' })
      .expect(200);
    await conAuth('patch', `/tickets/${ticketId}/status`, agente)
      .send({ status: 'CLOSED' })
      .expect(200);

    await etiquetar(ticketId, [etiqueta.id]).expect(409);
  });

  it('un agente no renombra ni borra; el ADMIN sí', async () => {
    const etiqueta = await crearEtiqueta('Renombrable');

    await conAuth('patch', `/tags/${etiqueta.id}`, agente)
      .send({ name: 'Otra' })
      .expect(403);
    await conAuth('delete', `/tags/${etiqueta.id}`, agente).expect(403);

    const res = await conAuth('patch', `/tags/${etiqueta.id}`, acme.token)
      .send({ name: 'Renombrada', color: 'teal' })
      .expect(200);
    expect(res.body).toMatchObject({ name: 'Renombrada', color: 'teal' });
  });

  it('borrar una etiqueta la quita de sus tickets y el historial conserva el nombre', async () => {
    const efimera = await crearEtiqueta('Efímera');
    const ticketId = await crearTicket('Pierde la etiqueta');
    await etiquetar(ticketId, [efimera.id]).expect(200);

    await conAuth('delete', `/tags/${efimera.id}`, acme.token).expect(204);

    const detalle = await conAuth('get', `/tickets/${ticketId}`, agente).expect(
      200,
    );
    expect((detalle.body as { tags: Etiqueta[] }).tags).toEqual([]);

    const historial = await conAuth(
      'get',
      `/tickets/${ticketId}/history`,
      agente,
    ).expect(200);
    const entradas = historial.body as {
      action: string;
      metadata: { added?: { name: string }[] };
    }[];
    const etiquetado = entradas.find((e) => e.action === 'ticket.tags_changed');
    expect(etiquetado?.metadata.added?.[0]?.name).toBe('Efímera');
  });

  it('varios agentes etiquetando a la vez: ninguno da 500 y gana uno entero', async () => {
    // Revisión final: sin bloquear la fila del ticket, dos `PUT` que comparten
    // una etiqueta chocaban en la PK de `ticket_tags` (P2002 → 500).
    const a = await crearEtiqueta('Carrera A');
    const b = await crearEtiqueta('Carrera B');
    const c = await crearEtiqueta('Carrera C');
    const ticketId = await crearTicket('En carrera');
    const conjuntos = [
      [a.id, b.id],
      [a.id, c.id],
      [b.id, c.id],
      [a.id, b.id, c.id],
      [c.id, a.id],
      [b.id, a.id],
    ];

    const respuestas = await Promise.all(
      conjuntos.map((ids) => etiquetar(ticketId, ids)),
    );

    expect(respuestas.map((r) => r.status)).toEqual(conjuntos.map(() => 200));
    const detalle = await conAuth('get', `/tickets/${ticketId}`, agente).expect(
      200,
    );
    const final = (detalle.body as { tags: Etiqueta[] }).tags
      .map((t) => t.id)
      .sort();
    expect(conjuntos.map((ids) => [...ids].sort())).toContainEqual(final);
  });

  describe('bordes (menores de la revisión)', () => {
    it('11 copias del mismo id son UNA etiqueta: 200, no 400', async () => {
      const etiqueta = await crearEtiqueta('Repetida');
      const ticketId = await crearTicket('Con repetidas');

      const res = await etiquetar(
        ticketId,
        Array.from({ length: 11 }, () => etiqueta.id),
      ).expect(200);

      expect((res.body as { tags: Etiqueta[] }).tags).toHaveLength(1);
    });

    it('un nombre que solo pasa de 40 por los espacios de los bordes se acepta', async () => {
      const nombre = 'n'.repeat(40);

      const res = await conAuth('post', '/tags', agente)
        .send({ name: `   ${nombre}   ` })
        .expect(201);

      expect((res.body as Etiqueta).name).toBe(nombre);
    });

    it('un id en mayúsculas es la misma etiqueta', async () => {
      const etiqueta = await crearEtiqueta('Mayúsculas');
      const ticketId = await crearTicket('Id en mayúsculas');

      await etiquetar(ticketId, [etiqueta.id.toUpperCase()]).expect(200);

      const res = await conAuth(
        'get',
        `/tickets?tagId=${etiqueta.id.toUpperCase()}`,
        agente,
      ).expect(200);
      const ids = (res.body as { items: { id: string }[] }).items.map(
        (t) => t.id,
      );
      expect(ids).toContain(ticketId);
    });
  });
});
