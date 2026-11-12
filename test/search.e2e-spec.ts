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

interface Pagina {
  items: { id: string; number: number }[];
  nextCursor: string | null;
}

const PASSWORD = 'un-password-seguro';

describe('Búsqueda (e2e, ADR-0032)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  // Palabras únicas por corrida: la base de desarrollo tiene otros tickets.
  const run = randomUUID().slice(0, 8);
  const palabra = (base: string) => `${base}${run}`;
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
    metodo: 'get' | 'post' | 'patch',
    ruta: string,
    token: string,
  ) =>
    request(app.getHttpServer())
      [metodo](ruta)
      .set('Authorization', `Bearer ${token}`);

  const crearTicket = async (
    subject: string,
    description = 'Detalle del problema.',
    org: Organizacion = acme,
  ) => {
    const res = await conAuth('post', '/tickets', org.token)
      .send({ subject, description })
      .expect(201);
    return res.body as { id: string; number: number };
  };

  const comentar = (
    ticketId: string,
    body: string,
    visibility: 'PUBLIC' | 'INTERNAL',
  ) =>
    conAuth('post', `/tickets/${ticketId}/comments`, agente)
      .send({ body, visibility })
      .expect(201);

  const buscar = async (q: string, token = agente, extra = '') => {
    const res = await conAuth(
      'get',
      `/tickets?q=${encodeURIComponent(q)}${extra}`,
      token,
    ).expect(200);
    return res.body as Pagina;
  };

  const ids = (p: Pagina) => p.items.map((t) => t.id);

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);

    acme = await registrar(`acme-q-${run}`);
    otra = await registrar(`otra-q-${run}`);
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

  it('encuentra por el asunto y por la descripción', async () => {
    const porAsunto = await crearTicket(`El ${palabra('pdf')} sale en blanco`);
    const porDescripcion = await crearTicket(
      'Otro asunto',
      `Al abrir el ${palabra('reporte')} se cuelga.`,
    );

    expect(ids(await buscar(palabra('pdf')))).toEqual([porAsunto.id]);
    expect(ids(await buscar(palabra('reporte')))).toEqual([porDescripcion.id]);
  });

  it('sin distinguir acentos y con prefijos', async () => {
    const ticket = await crearTicket(`La facturación${run} de octubre`);

    expect(ids(await buscar(`facturacion${run}`))).toContain(ticket.id);
    expect(ids(await buscar(`FACTURACIÓN${run}`))).toContain(ticket.id);
  });

  it('el prefijo encuentra la palabra completa ("fact" → "facturas")', async () => {
    // La palabra única hace que solo pueda coincidir este ticket; "fact" es la
    // parte que prueba el prefijo contra el término ya reducido por el idioma.
    const marca = palabra('zz');
    const ticket = await crearTicket(`Las facturas vencidas ${marca}`);

    expect(ids(await buscar(`fact ${marca}`))).toEqual([ticket.id]);
    expect(ids(await buscar(`venc ${marca}`))).toEqual([ticket.id]);
  });

  it('encuentra por un comentario público, para todos', async () => {
    const ticket = await crearTicket('Sin pistas en el asunto');
    await comentar(
      ticket.id,
      `Probá limpiando la ${palabra('cache')}`,
      'PUBLIC',
    );

    expect(ids(await buscar(palabra('cache')))).toEqual([ticket.id]);
    expect(ids(await buscar(palabra('cache'), viewer))).toEqual([ticket.id]);
  });

  it('una palabra que solo está en una nota interna no la encuentra el cliente', async () => {
    const ticket = await crearTicket('Ticket con nota');
    await comentar(
      ticket.id,
      `Es el bug de la ${palabra('migracion')}`,
      'INTERNAL',
    );

    expect(ids(await buscar(palabra('migracion')))).toEqual([ticket.id]);
    expect(ids(await buscar(palabra('migracion'), viewer))).toEqual([]);
  });

  it('#número y número a secas encuentran el ticket', async () => {
    const ticket = await crearTicket(`Por número ${run}`);

    expect(ids(await buscar(`#${ticket.number}`))).toContain(ticket.id);
    expect(ids(await buscar(String(ticket.number)))).toContain(ticket.id);
  });

  it.each([
    'a & | ! (b',
    ':*',
    `'"`,
    '!!!',
    '   ',
    // Letras/números que `unaccent` convierte en sintaxis de tsquery (revisión final).
    'ʼhola',
    'ŉ',
    '⑴',
    'aːb',
  ])(
    'texto con sintaxis rara no rompe (%p)',
    async (q) => {
      await buscar(q);
    },
  );

  it('se combina con otros filtros y con la paginación por cursor', async () => {
    const clave = palabra('combinado');
    const creados: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      creados.push((await crearTicket(`${clave} ${i}`)).id);
    }
    const enCurso = creados[1];
    await conAuth('patch', `/tickets/${enCurso}/status`, agente)
      .send({ status: 'IN_PROGRESS' })
      .expect(200);

    expect(ids(await buscar(clave, agente, '&status=IN_PROGRESS'))).toEqual([
      enCurso,
    ]);

    const primera = await buscar(clave, agente, '&limit=2');
    expect(primera.items).toHaveLength(2);
    expect(primera.nextCursor).not.toBeNull();
    const segunda = await buscar(
      clave,
      agente,
      `&limit=2&cursor=${primera.nextCursor}`,
    );
    expect([...ids(primera), ...ids(segunda)].sort()).toEqual(
      [...creados].sort(),
    );
  });

  it('otra organización con la misma palabra no se mezcla', async () => {
    const clave = palabra('compartida');
    const propio = await crearTicket(`Con ${clave}`);
    await crearTicket(`También con ${clave}`, 'De la otra.', otra);

    expect(ids(await buscar(clave))).toEqual([propio.id]);
  });

  it('un texto de más de 200 caracteres es un 400', async () => {
    await conAuth('get', `/tickets?q=${'x'.repeat(201)}`, agente).expect(400);
  });

  it('el tope de 1000 coincidencias no se come a los filtros', async () => {
    // Revisión final: el tope se aplicaba ANTES del filtro de estado. Con 1000
    // coincidencias abiertas más recientes, el único ticket cerrado (más viejo)
    // quedaba afuera y `status=CLOSED` devolvía una página vacía.
    const volumen = await registrar(`vol-q-${run}`);
    const clave = palabra('volumen');
    const viejo = new Date('2026-01-01T00:00:00Z');
    const base = {
      tenantId: volumen.tenantId,
      requesterId: volumen.userId,
      description: 'Carga masiva para el test del tope.',
    };
    await prisma.withTenant(volumen.tenantId, async (tx) => {
      await tx.ticket.create({
        data: {
          ...base,
          number: 1,
          subject: `Cerrado ${clave}`,
          status: 'CLOSED',
          createdAt: viejo,
          updatedAt: viejo,
          closedAt: viejo,
        },
      });
      await tx.ticket.createMany({
        data: Array.from({ length: 1000 }, (_, i) => ({
          ...base,
          number: i + 2,
          subject: `Abierto ${i} ${clave}`,
          updatedAt: new Date(),
        })),
      });
    });

    const res = await conAuth(
      'get',
      `/tickets?q=${clave}&status=CLOSED`,
      volumen.token,
    ).expect(200);

    expect((res.body as Pagina).items.map((t) => t.number)).toEqual([1]);

    await prisma.withTenant(volumen.tenantId, (tx) =>
      tx.organization.deleteMany({ where: { id: volumen.tenantId } }),
    );
  });
});

