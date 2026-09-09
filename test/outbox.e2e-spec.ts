import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';

process.env.THROTTLE_SKIP = '1';

interface Organizacion {
  tenantId: string;
  userId: string;
  token: string;
}

const PASSWORD = 'un-password-seguro';

/**
 * El outbox transaccional (ADR-0007 / ADR-0018) contra Postgres real.
 *
 * Lo que se prueba aquí NO se puede probar con dobles: que el evento y el cambio
 * que lo produjo comparten commit de verdad. Un doble siempre puede fingir que
 * sí; solo la base de datos dice la verdad sobre lo que sobrevive a un rollback.
 */
describe('Outbox (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  const run = randomUUID().slice(0, 8);
  let acme: Organizacion;
  let otra: Organizacion;

  const registrar = async (nombre: string): Promise<Organizacion> => {
    const res = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        organizationName: nombre,
        email: `ana@${nombre}.test`,
        password: PASSWORD,
      })
      .expect(201);

    const token = (res.body as { accessToken: string }).accessToken;
    const claims = JSON.parse(
      Buffer.from(token.split('.')[1], 'base64url').toString('utf8'),
    ) as { sub: string; tenantId: string };

    return { tenantId: claims.tenantId, userId: claims.sub, token };
  };

  const crearTicket = (org: Organizacion, body: Record<string, unknown> = {}) =>
    request(app.getHttpServer())
      .post('/tickets')
      .set('Authorization', `Bearer ${org.token}`)
      .send({
        subject: 'No puedo entrar',
        description: 'Me da un error 500.',
        ...body,
      });

  /** Lee el outbox del tenant. Pasa por `withTenant`, así que RLS aplica. */
  const outboxDe = (org: Organizacion, aggregateId?: string) =>
    prisma.withTenant(org.tenantId, (tx) =>
      tx.outboxMessage.findMany({
        where: {
          tenantId: org.tenantId,
          ...(aggregateId === undefined ? {} : { aggregateId }),
        },
        orderBy: { occurredAt: 'asc' },
      }),
    );

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);

    acme = await registrar(`outbox-acme-${run}`);
    otra = await registrar(`outbox-otra-${run}`);
  });

  afterAll(async () => {
    for (const org of [acme, otra]) {
      await prisma.withTenant(org.tenantId, (tx) =>
        tx.organization.deleteMany({ where: { id: org.tenantId } }),
      );
    }
    await app.close();
  });

  it('crear un ticket deja su evento pendiente de publicar', async () => {
    const res = await crearTicket(acme).expect(201);
    const ticket = res.body as { id: string; number: number };

    const mensajes = await outboxDe(acme, ticket.id);

    expect(mensajes).toHaveLength(1);
    expect(mensajes[0].eventName).toBe('ticket.created');
    expect(mensajes[0].aggregateType).toBe('ticket');
    expect(mensajes[0].version).toBe(1);
    // Nadie lo ha publicado todavía: eso es trabajo del publicador (fase 5b).
    expect(mensajes[0].publishedAt).toBeNull();
    expect(mensajes[0].attempts).toBe(0);
    expect(mensajes[0].payload).toMatchObject({
      number: ticket.number,
      status: 'OPEN',
      requesterId: acme.userId,
    });
  });

  it('un alta rechazada por el dominio no deja evento ni ticket', async () => {
    // El asunto pasa la validación de forma del DTO pero el dominio lo rechaza:
    // el camino que ya reservó el número y va a revertir.
    const antes = await outboxDe(acme);

    await crearTicket(acme, { subject: '   ' }).expect(400);

    const despues = await outboxDe(acme);
    expect(despues).toHaveLength(antes.length);
  });

  it('una transición ilegal no deja evento', async () => {
    const res = await crearTicket(acme).expect(201);
    const ticketId = (res.body as { id: string }).id;

    await request(app.getHttpServer())
      .patch(`/tickets/${ticketId}/status`)
      .set('Authorization', `Bearer ${acme.token}`)
      .send({ status: 'CLOSED' })
      .expect(409);

    const mensajes = await outboxDe(acme, ticketId);
    // Solo la creación: el rollback se llevó por delante el evento del cambio.
    expect(mensajes.map((m) => m.eventName)).toEqual(['ticket.created']);
  });

  it('acumula los eventos de un agregado en orden', async () => {
    const res = await crearTicket(acme).expect(201);
    const ticketId = (res.body as { id: string }).id;

    await request(app.getHttpServer())
      .patch(`/tickets/${ticketId}/status`)
      .set('Authorization', `Bearer ${acme.token}`)
      .send({ status: 'IN_PROGRESS' })
      .expect(200);

    await request(app.getHttpServer())
      .post(`/tickets/${ticketId}/comments`)
      .set('Authorization', `Bearer ${acme.token}`)
      .send({ body: 'Ya lo miramos.' })
      .expect(201);

    const mensajes = await outboxDe(acme, ticketId);

    expect(mensajes.map((m) => m.eventName)).toEqual([
      'ticket.created',
      'ticket.status_changed',
      'comment.added',
    ]);
    // El comentario se ancla al TICKET, no a sí mismo: los eventos de un ticket
    // comparten `aggregateId` y por tanto se pueden ordenar entre sí.
    expect(new Set(mensajes.map((m) => m.aggregateId))).toEqual(
      new Set([ticketId]),
    );
  });

  it('el evento lleva el tenantId, que es lo que el worker necesita para reabrir RLS', async () => {
    const res = await crearTicket(acme).expect(201);
    const ticketId = (res.body as { id: string }).id;

    const [mensaje] = await outboxDe(acme, ticketId);

    // El publicador y el consumidor corren fuera de toda request: sin este campo
    // no tendrían forma de fijar `app.current_tenant` antes de tocar la BD.
    expect(mensaje.tenantId).toBe(acme.tenantId);
  });

  it('el outbox está aislado por organización', async () => {
    const res = await crearTicket(otra).expect(201);
    const ticketAjeno = (res.body as { id: string }).id;

    // Se busca el ticket de `otra` PERO con el contexto de tenant de `acme`.
    const desdeAcme = await prisma.withTenant(acme.tenantId, (tx) =>
      tx.outboxMessage.findMany({ where: { aggregateId: ticketAjeno } }),
    );

    expect(desdeAcme).toHaveLength(0);
    // Y desde su propia organización sí se ve.
    expect(await outboxDe(otra, ticketAjeno)).toHaveLength(1);
  });
});
