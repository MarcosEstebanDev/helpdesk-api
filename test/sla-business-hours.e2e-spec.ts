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
  AI_TRIAGE_QUEUE,
  SLA_QUEUE,
  TICKET_ROUTING_QUEUE,
} from '../src/infrastructure/queue/queues';
import { SlaProcessor } from '../src/modules/ticketing/infrastructure/queue/sla.processor';
import { CLOCK, Clock } from '../src/shared-kernel';

process.env.THROTTLE_SKIP = '1';

const PASSWORD = 'un-password-seguro';

/**
 * El SLA cuenta con el horario laboral de la organización (ADR-0034), de punta
 * a punta: ticket por HTTP → outbox → consumidor de SLA → `sla_timers`.
 * Sin configurar nada rige el horario por defecto (L–V 08:00–18:00, Argentina).
 */
describe('SLA con horario laboral (e2e, ADR-0034)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let publisher: OutboxPublisher;
  let processor: SlaProcessor;
  let slaQueue: Queue;
  let routingQueue: Queue;
  // Sábado 14/11/2026 22:00 en Argentina: la oficina está cerrada.
  const AHORA = new Date('2026-11-15T01:00:00.000Z');
  const reloj: Clock = { now: () => new Date(AHORA) };

  const run = randomUUID().slice(0, 8);
  const slug = `sla-bh-${run}`;
  const email = `ana@${slug}.test`;
  let tenantId = '';
  let token = '';
  const mensajes: string[] = [];

  const procesarSla = async (aggregateId: string, eventName: string) => {
    await publisher.publishPending();
    const mensaje = await prisma.withTenant(tenantId, (tx) =>
      tx.outboxMessage.findFirst({
        where: { tenantId, aggregateId, eventName },
        orderBy: { occurredAt: 'desc' },
      }),
    );
    if (mensaje === null) throw new Error(`sin mensaje ${eventName}`);
    const job = await slaQueue.getJob(mensaje.id);
    if (job === undefined) throw new Error(`sin job para ${eventName}`);
    mensajes.push(mensaje.id);
    return processor.process(job as Job<EventJobData>);
  };

  const vencimientos = async (ticketId: string) => {
    const timers = await prisma.withTenant(tenantId, (tx) =>
      tx.slaTimer.findMany({ where: { tenantId, ticketId } }),
    );
    return Object.fromEntries(
      timers.map((t) => [t.kind, t.dueAt.toISOString()]),
    );
  };

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
    publisher = app.get(OutboxPublisher);
    processor = app.get(SlaProcessor);
    slaQueue = app.get<Queue>(getQueueToken(SLA_QUEUE));
    routingQueue = app.get<Queue>(getQueueToken(TICKET_ROUTING_QUEUE));

    const res = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ organizationName: slug, email, password: PASSWORD })
      .expect(201);
    token = (res.body as { accessToken: string }).accessToken;
    tenantId = (
      JSON.parse(
        Buffer.from(token.split('.')[1], 'base64url').toString('utf8'),
      ) as { tenantId: string }
    ).tenantId;
  });

  afterAll(async () => {
    for (const id of mensajes) {
      await slaQueue.remove(id).catch(() => undefined);
      await routingQueue.remove(id).catch(() => undefined);
      await app
        .get<Queue>(getQueueToken(AI_TRIAGE_QUEUE))
        .remove(id)
        .catch(() => undefined);
    }
    await prisma.withTenant(tenantId, (tx) =>
      tx.organization.deleteMany({ where: { id: tenantId } }),
    );
    await app.close();
  });

  it('un ticket del sábado a la noche empieza a contar el lunes a las 8', async () => {
    const res = await request(app.getHttpServer())
      .post('/tickets')
      .set('Authorization', `Bearer ${token}`)
      .send({
        subject: 'Entró el sábado',
        description: 'Sin acceso.',
        priority: 'NORMAL',
      })
      .expect(201);
    const id = (res.body as { id: string }).id;

    await procesarSla(id, 'ticket.created');

    // NORMAL: respuesta 4 h, resolución 10 h hábiles. Lunes 16/11 08:00 ART.
    expect(await vencimientos(id)).toEqual({
      RESPONSE: '2026-11-16T15:00:00.000Z', // lunes 12:00
      // 10 h = el lunes entero: vence al CIERRE del lunes (18:00), no el
      // martes a las 08:00.
      RESOLUTION: '2026-11-16T21:00:00.000Z',
    });
  });

  it('un feriado cargado corre el vencimiento al día hábil siguiente', async () => {
    await request(app.getHttpServer())
      .post('/business-hours/exceptions')
      .set('Authorization', `Bearer ${token}`)
      .send({ date: '2026-11-16', working: false, name: 'Feriado de prueba' })
      .expect(201);
    const res = await request(app.getHttpServer())
      .post('/tickets')
      .set('Authorization', `Bearer ${token}`)
      .send({
        subject: 'Antes del feriado',
        description: 'Detalle.',
        priority: 'NORMAL',
      })
      .expect(201);
    const id = (res.body as { id: string }).id;

    await procesarSla(id, 'ticket.created');

    expect((await vencimientos(id)).RESPONSE).toBe('2026-11-17T15:00:00.000Z'); // martes 12:00
  });
});
