import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import { Role } from '../src/modules/iam/domain/role';

// Esta suite hace varios logins para cambiar de rol; el rate limiting tiene su
// propia suite (`auth-rate-limit.e2e-spec.ts`).
process.env.THROTTLE_SKIP = '1';

interface Organizacion {
  slug: string;
  email: string;
  tenantId: string;
  userId: string;
  token: string;
}

const PASSWORD = 'un-password-seguro';

describe('Tickets (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  const run = randomUUID().slice(0, 8);
  /** Organización principal. */
  let acme: Organizacion;
  /** Segunda organización: existe para demostrar el aislamiento. */
  let otra: Organizacion;
  /** Segundo miembro de `acme`, destinatario de las asignaciones. */
  let agenteId: string;

  // --------------------------------------------------------------- utilidades

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
      // `slugify` del dominio produce el slug a partir del nombre; los nombres
      // de este test ya vienen en minúsculas y con guiones.
      slug: nombre,
      email,
      tenantId: claims.tenantId,
      userId: claims.sub,
      token,
    };
  };

  /** Cambia el rol del usuario en la BD y devuelve un token nuevo con ese rol. */
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

  // Sin `async`: debe devolver el encadenable de supertest para poder seguir
  // con `.expect(...)`; una función async lo envolvería en una promesa.
  const crearTicket = (token: string, body: Record<string, unknown> = {}) =>
    request(app.getHttpServer())
      .post('/tickets')
      .set('Authorization', `Bearer ${token}`)
      .send({
        subject: 'No puedo entrar',
        description: 'Me da un error 500.',
        ...body,
      });

  const conAuth = (
    metodo: 'get' | 'post' | 'patch' | 'delete',
    ruta: string,
    token: string,
  ) =>
    request(app.getHttpServer())
      [metodo](ruta)
      .set('Authorization', `Bearer ${token}`);

  // ------------------------------------------------------------------- setup

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);

    acme = await registrar(`acme-${run}`);
    otra = await registrar(`otra-${run}`);

    // Un segundo miembro en `acme` para poder asignarle tickets. Se inserta
    // directo porque todavía no hay endpoint de invitación (no es de esta fase).
    agenteId = randomUUID();
    await prisma.withTenant(acme.tenantId, async (tx) => {
      await tx.user.create({
        data: {
          id: agenteId,
          tenantId: acme.tenantId,
          email: `agente@acme-${run}.test`,
          passwordHash: 'no-se-usa-en-este-test',
        },
      });
      await tx.membership.create({
        data: {
          id: randomUUID(),
          tenantId: acme.tenantId,
          userId: agenteId,
          role: 'AGENT',
        },
      });
    });
  });

  afterAll(async () => {
    for (const org of [acme, otra]) {
      await prisma.withTenant(org.tenantId, (tx) =>
        tx.organization.deleteMany({ where: { id: org.tenantId } }),
      );
    }
    await app.close();
  });

  // ------------------------------------------------------------- numeración

  describe('numeración visible (ADR-0017)', () => {
    it('es correlativa y empieza en 1 dentro de cada organización', async () => {
      const primero = await crearTicket(acme.token).expect(201);
      const segundo = await crearTicket(acme.token).expect(201);

      expect((primero.body as { number: number }).number).toBe(1);
      expect((segundo.body as { number: number }).number).toBe(2);
    });

    it('cada organización tiene su propia serie', async () => {
      // La prueba de que el contador es POR TENANT y no global: `otra` acaba de
      // crear su primer ticket y también recibe el #1.
      const suyo = await crearTicket(otra.token).expect(201);

      expect((suyo.body as { number: number }).number).toBe(1);
    });

    it('un alta rechazada por el dominio no deja hueco en la serie', async () => {
      // El asunto pasa la validación de forma del DTO (`@Length(1, 200)`) pero
      // el dominio lo recorta y lo rechaza. Es el camino que reserva el número
      // y luego falla: si la transacción no revirtiera, el siguiente ticket
      // saltaría un número.
      await crearTicket(acme.token, { subject: '   ' }).expect(400);

      const siguiente = await crearTicket(acme.token).expect(201);

      // Ya se habían creado 2 tickets en `acme`, así que toca el 3.
      expect((siguiente.body as { number: number }).number).toBe(3);
    });
  });

  // -------------------------------------------------------------- aislamiento

  describe('aislamiento entre organizaciones (RLS)', () => {
    let ticketDeAcme: string;

    beforeAll(async () => {
      const res = await crearTicket(acme.token, {
        subject: 'Secreto de Acme',
      }).expect(201);
      ticketDeAcme = (res.body as { id: string }).id;
    });

    it('otra organización no ve el ticket ni conociendo su id', async () => {
      // 404 y no 403: un 403 confirmaría que ese id existe en algún sitio.
      await conAuth('get', `/tickets/${ticketDeAcme}`, otra.token).expect(404);
    });

    it('el listado de cada organización solo contiene lo suyo', async () => {
      const res = await conAuth('get', '/tickets?limit=100', otra.token).expect(
        200,
      );
      const items = (res.body as { items: { id: string }[] }).items;

      expect(items.some((t) => t.id === ticketDeAcme)).toBe(false);
      expect(items.length).toBeGreaterThan(0); // sí ve los suyos
    });

    it('no se puede mover el estado de un ticket ajeno', async () => {
      await conAuth('patch', `/tickets/${ticketDeAcme}/status`, otra.token)
        .send({ status: 'IN_PROGRESS' })
        .expect(404);
    });

    it('no se puede asignar un ticket a un usuario de otra organización', async () => {
      await conAuth('post', `/tickets/${ticketDeAcme}/assign`, acme.token)
        .send({ assigneeId: otra.userId })
        .expect(404);
    });
  });

  // ------------------------------------------------------- máquina de estados

  describe('máquina de estados (ADR-0015)', () => {
    let ticketId: string;

    beforeEach(async () => {
      const res = await crearTicket(acme.token).expect(201);
      ticketId = (res.body as { id: string }).id;
    });

    const mover = (status: string) =>
      conAuth('patch', `/tickets/${ticketId}/status`, acme.token).send({
        status,
      });

    it('recorre el ciclo de vida completo', async () => {
      await mover('IN_PROGRESS').expect(200);
      await mover('RESOLVED').expect(200);
      const cerrado = await mover('CLOSED').expect(200);

      expect((cerrado.body as { status: string }).status).toBe('CLOSED');
    });

    it('rechaza con 409 una transición que no está en la tabla', async () => {
      const res = await mover('CLOSED').expect(409);

      // Conflict y no Bad Request: la petición está bien formada, lo que choca
      // es el estado actual del recurso.
      expect((res.body as { code: string }).code).toBe(
        'ticketing.invalid_transition',
      );
    });

    it('un ticket cerrado ya no se mueve ni admite comentarios', async () => {
      await mover('RESOLVED').expect(200);
      await mover('CLOSED').expect(200);

      await mover('OPEN').expect(409);
      await conAuth('post', `/tickets/${ticketId}/comments`, acme.token)
        .send({ body: 'Una cosa más' })
        .expect(409);
    });

    it('resolver sella resolvedAt y cerrar lo conserva', async () => {
      await mover('RESOLVED').expect(200);
      await mover('CLOSED').expect(200);

      const res = await conAuth(
        'get',
        `/tickets/${ticketId}`,
        acme.token,
      ).expect(200);
      const detalle = res.body as {
        resolvedAt: string | null;
        closedAt: string | null;
      };

      expect(detalle.resolvedAt).not.toBeNull();
      expect(detalle.closedAt).not.toBeNull();
    });

    it('rechaza un estado que no existe antes de llegar al dominio', async () => {
      await mover('ARCHIVED').expect(400);
    });
  });

  // ---------------------------------------------------------- asignación

  describe('asignación', () => {
    let ticketId: string;

    beforeEach(async () => {
      const res = await crearTicket(acme.token).expect(201);
      ticketId = (res.body as { id: string }).id;
    });

    it('asigna a un miembro y luego devuelve el ticket a la cola', async () => {
      const asignado = await conAuth(
        'post',
        `/tickets/${ticketId}/assign`,
        acme.token,
      )
        .send({ assigneeId: agenteId })
        .expect(200);

      expect((asignado.body as { assigneeId: string }).assigneeId).toBe(
        agenteId,
      );
      // Asignar no arranca el trabajo.
      expect((asignado.body as { status: string }).status).toBe('OPEN');

      const libre = await conAuth(
        'delete',
        `/tickets/${ticketId}/assign`,
        acme.token,
      ).expect(200);
      expect((libre.body as { assigneeId: null }).assigneeId).toBeNull();
    });

    it('permite filtrar el listado por agente asignado', async () => {
      await conAuth('post', `/tickets/${ticketId}/assign`, acme.token)
        .send({ assigneeId: agenteId })
        .expect(200);

      const res = await conAuth(
        'get',
        `/tickets?assigneeId=${agenteId}&limit=100`,
        acme.token,
      ).expect(200);
      const items = (res.body as { items: { id: string }[] }).items;

      expect(items.some((t) => t.id === ticketId)).toBe(true);
    });
  });

  // ------------------------------------------------------------- auditoría

  describe('rastro de auditoría (ADR-0016)', () => {
    it('registra cada cambio, en la misma transacción que el cambio', async () => {
      const creado = await crearTicket(acme.token).expect(201);
      const ticketId = (creado.body as { id: string }).id;

      await conAuth('post', `/tickets/${ticketId}/assign`, acme.token)
        .send({ assigneeId: agenteId })
        .expect(200);
      await conAuth('patch', `/tickets/${ticketId}/status`, acme.token)
        .send({ status: 'IN_PROGRESS' })
        .expect(200);
      await conAuth('post', `/tickets/${ticketId}/comments`, acme.token)
        .send({ body: 'Ya lo miramos.' })
        .expect(201);

      const res = await conAuth(
        'get',
        `/tickets/${ticketId}/history`,
        acme.token,
      ).expect(200);
      const acciones = (res.body as { action: string }[]).map((e) => e.action);

      expect(acciones).toContain('ticket.created');
      expect(acciones).toContain('ticket.assigned');
      expect(acciones).toContain('ticket.status_changed');
      expect(acciones).toContain('comment.added');
    });

    it('un cambio rechazado no deja rastro', async () => {
      const creado = await crearTicket(acme.token).expect(201);
      const ticketId = (creado.body as { id: string }).id;

      await conAuth('patch', `/tickets/${ticketId}/status`, acme.token)
        .send({ status: 'CLOSED' })
        .expect(409);

      const res = await conAuth(
        'get',
        `/tickets/${ticketId}/history`,
        acme.token,
      ).expect(200);
      const acciones = (res.body as { action: string }[]).map((e) => e.action);

      // Solo la creación: la transición ilegal revirtió con su auditoría.
      expect(acciones).toEqual(['ticket.created']);
    });

    it('guarda el origen y el destino del cambio de estado', async () => {
      const creado = await crearTicket(acme.token).expect(201);
      const ticketId = (creado.body as { id: string }).id;

      await conAuth('patch', `/tickets/${ticketId}/status`, acme.token)
        .send({ status: 'RESOLVED' })
        .expect(200);

      const res = await conAuth(
        'get',
        `/tickets/${ticketId}/history`,
        acme.token,
      ).expect(200);
      const cambio = (res.body as { action: string; metadata: unknown }[]).find(
        (e) => e.action === 'ticket.status_changed',
      );

      expect(cambio?.metadata).toEqual({ from: 'OPEN', to: 'RESOLVED' });
    });
  });

  // ------------------------------------------------------------------- RBAC

  describe('permisos por rol (ADR-0014)', () => {
    let ticketId: string;
    let tokenViewer: string;

    beforeAll(async () => {
      const res = await crearTicket(acme.token).expect(201);
      ticketId = (res.body as { id: string }).id;
    });

    afterAll(async () => {
      // Se devuelve el rol de ADMIN para no condicionar a otras suites.
      acme.token = await tokenConRol(acme, 'ADMIN');
    });

    it('un VIEWER puede leer, abrir tickets y comentar', async () => {
      tokenViewer = await tokenConRol(acme, 'VIEWER');

      await conAuth('get', '/tickets', tokenViewer).expect(200);
      await crearTicket(tokenViewer).expect(201);
      await conAuth('post', `/tickets/${ticketId}/comments`, tokenViewer)
        .send({ body: 'Sigo sin poder entrar.' })
        .expect(201);
    });

    it('un VIEWER no puede operar la cola', async () => {
      tokenViewer = await tokenConRol(acme, 'VIEWER');

      await conAuth('patch', `/tickets/${ticketId}/status`, tokenViewer)
        .send({ status: 'IN_PROGRESS' })
        .expect(403);
      await conAuth('post', `/tickets/${ticketId}/assign`, tokenViewer)
        .send({ assigneeId: agenteId })
        .expect(403);
      await conAuth('get', `/tickets/${ticketId}/history`, tokenViewer).expect(
        403,
      );
    });

    it('un AGENT sí puede operar la cola', async () => {
      const tokenAgente = await tokenConRol(acme, 'AGENT');

      await conAuth('patch', `/tickets/${ticketId}/status`, tokenAgente)
        .send({ status: 'IN_PROGRESS' })
        .expect(200);
    });

    it('sin sesión no se llega a ninguna ruta de tickets', async () => {
      await request(app.getHttpServer()).get('/tickets').expect(401);
      await request(app.getHttpServer()).post('/tickets').send({}).expect(401);
    });
  });

  // -------------------------------------------------------------- paginación

  describe('listado', () => {
    it('pagina por cursor sin repetir ni saltarse elementos', async () => {
      const res = await conAuth('get', '/tickets?limit=2', acme.token).expect(
        200,
      );
      const primera = res.body as {
        items: { id: string }[];
        nextCursor: string | null;
      };

      expect(primera.items).toHaveLength(2);
      expect(primera.nextCursor).not.toBeNull();

      const res2 = await conAuth(
        'get',
        `/tickets?limit=2&cursor=${primera.nextCursor}`,
        acme.token,
      ).expect(200);
      const segunda = res2.body as { items: { id: string }[] };

      const idsPrimera = primera.items.map((t) => t.id);
      for (const item of segunda.items) {
        expect(idsPrimera).not.toContain(item.id);
      }
    });

    it('filtra por estado', async () => {
      const res = await conAuth(
        'get',
        '/tickets?status=OPEN&limit=100',
        acme.token,
      ).expect(200);
      const items = (res.body as { items: { status: string }[] }).items;

      expect(items.length).toBeGreaterThan(0);
      expect(items.every((t) => t.status === 'OPEN')).toBe(true);
    });

    it('rechaza un límite fuera de rango', async () => {
      await conAuth('get', '/tickets?limit=500', acme.token).expect(400);
    });
  });
});
