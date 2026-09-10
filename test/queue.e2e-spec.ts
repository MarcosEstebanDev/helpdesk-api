import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { Test, TestingModule } from '@nestjs/testing';
import { Job, Queue } from 'bullmq';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import type { EventJobData } from '../src/infrastructure/outbox/outbox-publisher.service';
import { OutboxPublisher } from '../src/infrastructure/outbox/outbox-publisher.service';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import {
  DEAD_LETTER_QUEUE,
  SLA_QUEUE,
  TICKET_ROUTING_QUEUE,
} from '../src/infrastructure/queue/queues';
import { AUTO_ASSIGN_CONSUMER } from '../src/modules/ticketing/application/auto-assign-ticket.use-case';
import { TicketRoutingProcessor } from '../src/modules/ticketing/infrastructure/queue/ticket-routing.processor';

process.env.THROTTLE_SKIP = '1';

const PASSWORD = 'un-password-seguro';

/**
 * Outbox -> cola -> consumidor, contra Postgres y Redis reales (ADR-0019).
 *
 * Cada paso se pide A MANO (`publishPending`, `process`) en vez de esperar a que
 * el temporizador del publicador y el worker hagan lo suyo. Con esperas, este
 * fichero sería la clase de test que falla una de cada veinte veces sin que
 * nadie sepa por qué. Lo único que no se ejercita así es el bucle de scheduling
 * de BullMQ, que es responsabilidad de BullMQ.
 */
describe('Colas y outbox (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let publisher: OutboxPublisher;
  let processor: TicketRoutingProcessor;
  let routing: Queue;
  let sla: Queue;
  let deadLetter: Queue;

  const run = randomUUID().slice(0, 8);
  let tenantId: string;
  let adminId: string;
  let token: string;
  let agenteId: string;

  /** Ids de job creados por esta suite, para limpiarlos al final. */
  const jobsCreados: { queue: Queue; id: string }[] = [];

  const crearTicket = (body: Record<string, unknown> = {}) =>
    request(app.getHttpServer())
      .post('/tickets')
      .set('Authorization', `Bearer ${token}`)
      .send({
        subject: 'No puedo entrar',
        description: 'Me da un error 500.',
        ...body,
      });

  const outboxDe = (aggregateId: string) =>
    prisma.withTenant(tenantId, (tx) =>
      tx.outboxMessage.findMany({
        where: { tenantId, aggregateId },
        orderBy: { occurredAt: 'asc' },
      }),
    );

  const ticketEnBd = (id: string) =>
    prisma.withTenant(tenantId, (tx) =>
      tx.ticket.findFirst({ where: { id, tenantId } }),
    );

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();

    prisma = app.get(PrismaService);
    publisher = app.get(OutboxPublisher);
    processor = app.get(TicketRoutingProcessor);
    routing = app.get<Queue>(getQueueToken(TICKET_ROUTING_QUEUE));
    sla = app.get<Queue>(getQueueToken(SLA_QUEUE));
    deadLetter = app.get<Queue>(getQueueToken(DEAD_LETTER_QUEUE));

    const res = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        organizationName: `colas-${run}`,
        email: `ana@colas-${run}.test`,
        password: PASSWORD,
      })
      .expect(201);

    token = (res.body as { accessToken: string }).accessToken;
    const claims = JSON.parse(
      Buffer.from(token.split('.')[1], 'base64url').toString('utf8'),
    ) as { sub: string; tenantId: string };
    tenantId = claims.tenantId;
    adminId = claims.sub;

    // Un segundo agente: con dos, el reparto round-robin se puede observar.
    agenteId = randomUUID();
    await prisma.withTenant(tenantId, async (tx) => {
      await tx.user.create({
        data: {
          id: agenteId,
          tenantId,
          email: `agente@colas-${run}.test`,
          passwordHash: 'no-se-usa',
        },
      });
      await tx.membership.create({
        data: { id: randomUUID(), tenantId, userId: agenteId, role: 'AGENT' },
      });
    });
  });

  afterAll(async () => {
    // Se borran solo los jobs de esta suite: `obliterate` se llevaría por delante
    // lo que hubiera en el Redis de desarrollo.
    for (const { queue, id } of jobsCreados) {
      await queue.remove(id).catch(() => undefined);
      // Desde la fase 6, `ticket.created` se encola TAMBIÉN en la cola de SLA
      // con el mismo jobId. Borrar de las dos evita dejar jobs huérfanos en el
      // Redis de desarrollo.
      await sla.remove(id).catch(() => undefined);
    }
    await prisma.withTenant(tenantId, (tx) =>
      tx.organization.deleteMany({ where: { id: tenantId } }),
    );
    await app.close();
  });

  // ------------------------------------------------------------- publicador

  describe('publicador del outbox', () => {
    it('encola el evento y marca el mensaje como publicado', async () => {
      const res = await crearTicket().expect(201);
      const ticket = res.body as { id: string; number: number };

      const [antes] = await outboxDe(ticket.id);
      expect(antes.publishedAt).toBeNull();

      await publisher.publishPending();

      const [despues] = await outboxDe(ticket.id);
      expect(despues.publishedAt).not.toBeNull();

      // Y el job está de verdad en Redis, con el id del MENSAJE como jobId.
      const job = await routing.getJob(antes.id);
      expect(job).toBeDefined();
      jobsCreados.push({ queue: routing, id: antes.id });

      const data = job?.data as EventJobData;
      expect(data.eventName).toBe('ticket.created');
      expect(data.tenantId).toBe(tenantId);
      expect(data.aggregateId).toBe(ticket.id);
      expect(data.payload).toMatchObject({ number: ticket.number });
    });

    it('no vuelve a publicar lo ya publicado', async () => {
      const res = await crearTicket().expect(201);
      const ticketId = (res.body as { id: string }).id;

      await publisher.publishPending();
      const [primera] = await outboxDe(ticketId);
      jobsCreados.push({ queue: routing, id: primera.id });
      expect(primera.publishedAt).not.toBeNull();

      await publisher.publishPending();

      // `published_at IS NULL` excluye el mensaje del siguiente lote, así que ni
      // se re-encola ni se re-marca. Se comprueba sobre ESTE mensaje y no sobre
      // el total de procesados: la base de datos es compartida por las suites.
      const [segunda] = await outboxDe(ticketId);
      expect(segunda.publishedAt).toEqual(primera.publishedAt);
    });

    it('un evento sin consumidor se marca publicado igualmente', async () => {
      // Si no, se reclamaría en cada tick para siempre. `ticket.assigned` no
      // está en el mapa de enrutado. (Hasta la fase 6 este caso se probaba con
      // `ticket.status_changed`, pero ese evento ya tiene consumidor: es el que
      // para el reloj de resolución del SLA.)
      const res = await crearTicket().expect(201);
      const ticketId = (res.body as { id: string }).id;
      await publisher.publishPending();

      await request(app.getHttpServer())
        .post(`/tickets/${ticketId}/assign`)
        .set('Authorization', `Bearer ${token}`)
        .send({ assigneeId: agenteId })
        .expect(200);

      await publisher.publishPending();

      const mensajes = await outboxDe(ticketId);
      const asignado = mensajes.find((m) => m.eventName === 'ticket.assigned');
      expect(asignado?.publishedAt).not.toBeNull();
      // Y no se creó job para él en ninguna cola.
      expect(await routing.getJob(asignado?.id ?? '')).toBeUndefined();
      expect(await sla.getJob(asignado?.id ?? '')).toBeUndefined();

      const creado = mensajes.find((m) => m.eventName === 'ticket.created');
      if (creado !== undefined)
        jobsCreados.push({ queue: routing, id: creado.id });
    });
  });

  // -------------------------------------------------------------- consumidor

  describe('consumidor: auto-asignación', () => {
    let ticketId: string;
    let job: Job<EventJobData>;

    beforeAll(async () => {
      const res = await crearTicket({ subject: 'Para asignar' }).expect(201);
      ticketId = (res.body as { id: string }).id;

      await publisher.publishPending();
      const [mensaje] = await outboxDe(ticketId);
      const encontrado = await routing.getJob(mensaje.id);
      if (encontrado === undefined) throw new Error('el job debería existir');
      job = encontrado as Job<EventJobData>;
      jobsCreados.push({ queue: routing, id: mensaje.id });
    });

    it('asigna el ticket a un agente de la organización', async () => {
      const resultado = await processor.process(job);

      expect(resultado.status).toBe('assigned');

      const enBd = await ticketEnBd(ticketId);
      expect(enBd?.assigneeId).not.toBeNull();
      // Reparte entre los DOS miembros que pueden atender (el ADMIN cuenta).
      expect([adminId, agenteId]).toContain(enBd?.assigneeId);
      // Asignar no arranca el trabajo.
      expect(enBd?.status).toBe('OPEN');
    });

    it('deja la marca de procesado en la misma transacción', async () => {
      const marca = await prisma.withTenant(tenantId, (tx) =>
        tx.processedMessage.findFirst({
          where: { consumer: AUTO_ASSIGN_CONSUMER, eventId: job.data.eventId },
        }),
      );

      expect(marca).not.toBeNull();
      expect(marca?.tenantId).toBe(tenantId);
    });

    it('reprocesar el MISMO job no cambia nada (at-least-once)', async () => {
      const antes = await ticketEnBd(ticketId);

      const resultado = await processor.process(job);

      expect(resultado).toEqual({
        status: 'skipped',
        reason: 'already_processed',
      });
      const despues = await ticketEnBd(ticketId);
      expect(despues?.assigneeId).toBe(antes?.assigneeId);
      expect(despues?.updatedAt).toEqual(antes?.updatedAt);
    });

    it('la asignación automática queda auditada a nombre del sistema', async () => {
      const historial = await prisma.withTenant(tenantId, (tx) =>
        tx.auditLog.findMany({
          where: { tenantId, entityId: ticketId, action: 'ticket.assigned' },
        }),
      );

      expect(historial).toHaveLength(1);
      expect(historial[0].actorId).toBe('00000000-0000-0000-0000-000000000000');
      expect(historial[0].metadata).toMatchObject({ automatic: true });
    });
  });

  // --------------------------------------------------------------------- DLQ

  describe('dead-letter queue', () => {
    it('un evento con versión desconocida va al descarte sin reintentarse', async () => {
      // Reintentar un formato que no entendemos no lo arregla: es un fallo
      // PERMANENTE, así que se descarta en el primer intento.
      const eventId = randomUUID();
      const data: EventJobData = {
        eventId,
        tenantId,
        aggregateType: 'ticket',
        aggregateId: randomUUID(),
        eventName: 'ticket.created',
        version: 99,
        payload: { number: 1 },
        occurredAt: new Date().toISOString(),
        // Este job se construye a mano, sin pasar por el outbox: no hay
        // petición de la que heredar correlación.
        requestId: null,
      };
      const envenenado = await routing.add('ticket.created', data, {
        jobId: eventId,
      });
      jobsCreados.push({ queue: routing, id: eventId });

      const resultado = await processor.process(
        envenenado as Job<EventJobData>,
      );

      expect(resultado.status).toBe('skipped');

      const enDlq = await deadLetter.getJob(`dlq-${eventId}`);
      jobsCreados.push({ queue: deadLetter, id: `dlq-${eventId}` });
      expect(enDlq).toBeDefined();
      expect((enDlq?.data as { reason: string }).reason).toContain('99');
      expect((enDlq?.data as { queue: string }).queue).toBe(
        TICKET_ROUTING_QUEUE,
      );
    });

    it('un evento que esta cola no maneja también se descarta', async () => {
      const eventId = randomUUID();
      const data: EventJobData = {
        eventId,
        tenantId,
        aggregateType: 'ticket',
        aggregateId: randomUUID(),
        eventName: 'comment.added',
        version: 1,
        payload: {},
        occurredAt: new Date().toISOString(),
        // Este job se construye a mano, sin pasar por el outbox: no hay
        // petición de la que heredar correlación.
        requestId: null,
      };
      const job = await routing.add('comment.added', data, { jobId: eventId });
      jobsCreados.push({ queue: routing, id: eventId });

      await processor.process(job as Job<EventJobData>);

      const enDlq = await deadLetter.getJob(`dlq-${eventId}`);
      jobsCreados.push({ queue: deadLetter, id: `dlq-${eventId}` });
      expect(enDlq).toBeDefined();
      expect((enDlq?.data as { reason: string }).reason).toContain(
        'comment.added',
      );
    });
  });
});
