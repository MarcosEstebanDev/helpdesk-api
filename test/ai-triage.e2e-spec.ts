// PRIMERO: fija el entorno antes de que nada importe AppModule (ver el fichero).
import {
  ENV_ANTERIOR,
  PUERTO_IA_FALSA,
  TOKEN_INTERNO,
} from './support/ai-triage-env';
import { randomUUID } from 'node:crypto';
import { createServer, IncomingMessage, Server } from 'node:http';
import { INestApplication } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import { Job, Queue } from 'bullmq';
import request from 'supertest';
import { App } from 'supertest/types';
import type { EventJobData } from '../src/infrastructure/outbox/outbox-publisher.service';
import { OutboxPublisher } from '../src/infrastructure/outbox/outbox-publisher.service';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import {
  AI_TRIAGE_QUEUE,
  DEAD_LETTER_QUEUE,
  REALTIME_QUEUE,
  SLA_QUEUE,
  TICKET_ROUTING_QUEUE,
} from '../src/infrastructure/queue/queues';
import { Role } from '../src/modules/iam/domain/role';
import { AiTriageProcessor } from '../src/modules/ticketing/infrastructure/queue/ai-triage.processor';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';

const PASSWORD = 'un-password-seguro';

/** Lo que el servicio de IA falso responderá a la próxima petición. */
interface RespuestaIa {
  status: number;
  body: unknown;
}

const RESPUESTA_OK: RespuestaIa = {
  status: 200,
  body: {
    classification: {
      category: 'billing',
      priority: 'HIGH',
      sentiment: 'negative',
      language: 'es',
    },
    meta: {
      provider: 'fake',
      model: 'fake-e2e',
      prompt_version: 'triage-v1',
      latency_ms: 12,
      input_tokens: 300,
      output_tokens: 25,
      attempts: 1,
    },
  },
};

/**
 * Triage con IA de punta a punta (ADR-0027): outbox -> cola `ai-triage` ->
 * adapter HTTP real -> servicio de IA FALSO (un servidor HTTP de Node) ->
 * tabla con RLS -> endpoint.
 *
 * El servicio de IA se sustituye por un servidor HTTP de verdad y no por un doble
 * del puerto: así se ejercita también el adapter —URL, cabecera del token,
 * traducción de códigos HTTP— por la red, como en producción.
 */
describe('Triage con IA (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let publisher: OutboxPublisher;
  let processor: AiTriageProcessor;
  let colas: Queue[];
  let aiQueue: Queue;
  let deadLetter: Queue;

  let iaFalsa: Server;
  let proxima: RespuestaIa = RESPUESTA_OK;
  const recibidas: { headers: IncomingMessage['headers']; body: unknown }[] =
    [];

  const run = randomUUID().slice(0, 8);
  const slug = `ia-${run}`;
  const email = `ana@ia-${run}.test`;
  let tenantId: string;
  let userId: string;
  let token: string;
  const jobsEncolados: string[] = [];

  const crearTicket = () =>
    request(app.getHttpServer())
      .post('/tickets')
      .set('Authorization', `Bearer ${token}`)
      .send({
        subject: 'Me cobraron dos veces',
        description: 'La factura de octubre salió duplicada.',
        priority: 'NORMAL',
      })
      .expect(201)
      .then((res) => (res.body as { id: string }).id);

  /** Publica el outbox y devuelve el job de `ticket.created` en la cola de IA. */
  const jobDeTriage = async (ticketId: string): Promise<Job<EventJobData>> => {
    await publisher.publishPending();
    const mensaje = await prisma.withTenant(tenantId, (tx) =>
      tx.outboxMessage.findFirst({
        where: { tenantId, aggregateId: ticketId, eventName: 'ticket.created' },
      }),
    );
    if (mensaje === null) throw new Error('sin mensaje ticket.created');
    jobsEncolados.push(mensaje.id);
    const job = await aiQueue.getJob(mensaje.id);
    if (job === undefined) throw new Error('sin job en la cola ai-triage');
    return job as Job<EventJobData>;
  };

  const tokenConRol = async (role: Role): Promise<string> => {
    await prisma.withTenant(tenantId, (tx) =>
      tx.membership.updateMany({ where: { userId, tenantId }, data: { role } }),
    );
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ organizationSlug: slug, email, password: PASSWORD })
      .expect(200);
    return (res.body as { accessToken: string }).accessToken;
  };

  beforeAll(async () => {
    iaFalsa = createServer((req, res) => {
      let crudo = '';
      req.on('data', (chunk: Buffer) => (crudo += chunk.toString()));
      req.on('end', () => {
        recibidas.push({
          headers: req.headers,
          body: JSON.parse(crudo) as unknown,
        });
        res.writeHead(proxima.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(proxima.body));
      });
    });
    await new Promise<void>((resolve) =>
      iaFalsa.listen(PUERTO_IA_FALSA, '127.0.0.1', resolve),
    );

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();

    prisma = app.get(PrismaService);
    publisher = app.get(OutboxPublisher);
    processor = app.get(AiTriageProcessor);
    aiQueue = app.get<Queue>(getQueueToken(AI_TRIAGE_QUEUE));
    deadLetter = app.get<Queue>(getQueueToken(DEAD_LETTER_QUEUE));
    colas = [
      aiQueue,
      app.get<Queue>(getQueueToken(TICKET_ROUTING_QUEUE)),
      app.get<Queue>(getQueueToken(SLA_QUEUE)),
      app.get<Queue>(getQueueToken(REALTIME_QUEUE)),
    ];

    const res = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ organizationName: slug, email, password: PASSWORD })
      .expect(201);
    token = (res.body as { accessToken: string }).accessToken;
    const claims = JSON.parse(
      Buffer.from(token.split('.')[1], 'base64url').toString('utf8'),
    ) as { sub: string; tenantId: string };
    tenantId = claims.tenantId;
    userId = claims.sub;
  });

  afterAll(async () => {
    // `ticket.created` va a CUATRO colas con el mismo jobId; se limpian todas.
    for (const id of jobsEncolados) {
      for (const cola of colas) await cola.remove(id).catch(() => undefined);
      await deadLetter.remove(`dlq-ai-${id}`).catch(() => undefined);
    }
    await prisma.withTenant(tenantId, (tx) =>
      tx.organization.deleteMany({ where: { id: tenantId } }),
    );
    await app.close();
    await new Promise<void>((resolve) => iaFalsa.close(() => resolve()));
    // El entorno es del proceso entero: devolverlo como estaba para las suites
    // que corran después en el mismo worker (`--runInBand`).
    if (ENV_ANTERIOR.url === undefined) delete process.env.AI_SERVICE_URL;
    else process.env.AI_SERVICE_URL = ENV_ANTERIOR.url;
    if (ENV_ANTERIOR.token === undefined) delete process.env.AI_SERVICE_TOKEN;
    else process.env.AI_SERVICE_TOKEN = ENV_ANTERIOR.token;
  });

  beforeEach(() => {
    proxima = RESPUESTA_OK;
    recibidas.length = 0;
  });

  it('clasifica el ticket y deja la sugerencia visible para el equipo', async () => {
    const ticketId = await crearTicket();

    // Antes de que corra el worker: pendiente, no 404.
    const antes = await request(app.getHttpServer())
      .get(`/tickets/${ticketId}/triage`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(antes.body).toEqual({ status: 'pending' });

    const resultado = await processor.process(await jobDeTriage(ticketId));
    expect(resultado).toEqual({
      status: 'triaged',
      category: 'billing',
      suggestedPriority: 'HIGH',
    });

    // Al servicio de IA le llega SOLO el texto, con el token interno.
    expect(recibidas).toHaveLength(1);
    expect(recibidas[0]?.body).toEqual({
      subject: 'Me cobraron dos veces',
      description: 'La factura de octubre salió duplicada.',
    });
    expect(recibidas[0]?.headers['x-internal-token']).toBe(TOKEN_INTERNO);

    const despues = await request(app.getHttpServer())
      .get(`/tickets/${ticketId}/triage`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(despues.body).toMatchObject({
      status: 'ready',
      category: 'billing',
      suggestedPriority: 'HIGH',
      sentiment: 'negative',
      language: 'es',
      model: 'fake-e2e',
      promptVersion: 'triage-v1',
    });
    // Sin telemetría en la vista del agente.
    expect(despues.body).not.toHaveProperty('inputTokens');
  });

  it('la IA sugiere, no decide: la prioridad del ticket no cambia', async () => {
    const ticketId = await crearTicket();
    await processor.process(await jobDeTriage(ticketId));

    const detalle = await request(app.getHttpServer())
      .get(`/tickets/${ticketId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect((detalle.body as { priority: string }).priority).toBe('NORMAL');

    // Pero queda auditado, y como acción del sistema.
    const historial = await request(app.getHttpServer())
      .get(`/tickets/${ticketId}/history`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const acciones = (historial.body as { action: string }[]).map(
      (e) => e.action,
    );
    expect(acciones).toContain('ticket.triaged');
  });

  it('reprocesar el mismo evento no vuelve a llamar a la IA', async () => {
    const ticketId = await crearTicket();
    const job = await jobDeTriage(ticketId);
    await processor.process(job);

    const segunda = await processor.process(job);

    expect(segunda).toEqual({ status: 'skipped', reason: 'already_triaged' });
    expect(recibidas).toHaveLength(1);
  });

  it('IA caída (503): el job falla para que la cola lo reintente', async () => {
    proxima = { status: 503, body: { detail: 'ollama no responde' } };
    const ticketId = await crearTicket();

    await expect(
      processor.process(await jobDeTriage(ticketId)),
    ).rejects.toThrow(/triage_unavailable/);
  });

  it('respuesta con una categoría desconocida: a la DLQ, sin guardar nada', async () => {
    proxima = {
      status: 200,
      body: {
        ...(RESPUESTA_OK.body as object),
        classification: {
          category: 'hackeado',
          priority: 'URGENT',
          sentiment: 'neutral',
          language: 'es',
        },
      },
    };
    const ticketId = await crearTicket();
    const job = await jobDeTriage(ticketId);

    const resultado = await processor.process(job);

    expect(resultado).toEqual({ status: 'skipped', reason: 'discarded' });
    expect(await deadLetter.getJob(`dlq-ai-${job.data.eventId}`)).toBeDefined();
    const fila = await prisma.withTenant(tenantId, (tx) =>
      tx.ticketTriage.findFirst({ where: { ticketId } }),
    );
    expect(fila).toBeNull();
  });

  it('un VIEWER (el cliente) no ve la sugerencia', async () => {
    const ticketId = await crearTicket();
    const tokenViewer = await tokenConRol('VIEWER');

    await request(app.getHttpServer())
      .get(`/tickets/${ticketId}/triage`)
      .set('Authorization', `Bearer ${tokenViewer}`)
      .expect(403);

    token = await tokenConRol('ADMIN');
  });

  it('otra organización no ve la sugerencia de este ticket (RLS)', async () => {
    const ticketId = await crearTicket();
    await processor.process(await jobDeTriage(ticketId));

    const otro = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        organizationName: `otra-${run}`,
        email: `eva@otra-${run}.test`,
        password: PASSWORD,
      })
      .expect(201);
    const tokenOtro = (otro.body as { accessToken: string }).accessToken;
    const otroTenant = (
      JSON.parse(
        Buffer.from(tokenOtro.split('.')[1], 'base64url').toString('utf8'),
      ) as { tenantId: string }
    ).tenantId;

    try {
      await request(app.getHttpServer())
        .get(`/tickets/${ticketId}/triage`)
        .set('Authorization', `Bearer ${tokenOtro}`)
        .expect(404);
    } finally {
      await prisma.withTenant(otroTenant, (tx) =>
        tx.organization.deleteMany({ where: { id: otroTenant } }),
      );
    }
  });
  describe('en la bandeja', () => {
    type Fila = {
      id: string;
      aiTriage?: { category: string; suggestedPriority: string } | null;
    };
    const bandeja = async (tk: string, qs = ''): Promise<Fila[]> =>
      request(app.getHttpServer())
        .get(`/tickets?limit=100${qs}`)
        .set('Authorization', `Bearer ${tk}`)
        .expect(200)
        .then((res) => (res.body as { items: Fila[] }).items);

    it('cada fila trae la sugerencia, o null si todavía no la hay', async () => {
      const clasificado = await crearTicket();
      await processor.process(await jobDeTriage(clasificado));
      const sinClasificar = await crearTicket();

      const filas = await bandeja(token);

      expect(filas.find((f) => f.id === clasificado)?.aiTriage).toEqual({
        category: 'billing',
        suggestedPriority: 'HIGH',
      });
      expect(filas.find((f) => f.id === sinClasificar)?.aiTriage).toBeNull();
    });

    it('aiSuggestsHigher deja solo los que la IA cree más urgentes', async () => {
      const masUrgente = await crearTicket(); // NORMAL, la IA dice HIGH
      await processor.process(await jobDeTriage(masUrgente));

      const menosUrgente = await crearTicket(); // NORMAL, la IA dice LOW
      proxima = {
        status: 200,
        body: {
          ...(RESPUESTA_OK.body as object),
          classification: {
            category: 'how_to',
            priority: 'LOW',
            sentiment: 'neutral',
            language: 'es',
          },
        },
      };
      await processor.process(await jobDeTriage(menosUrgente));

      const sinSugerencia = await crearTicket();

      const ids = (await bandeja(token, '&aiSuggestsHigher=true')).map(
        (f) => f.id,
      );

      expect(ids).toContain(masUrgente);
      expect(ids).not.toContain(menosUrgente);
      expect(ids).not.toContain(sinSugerencia);
    });

    it('a un VIEWER no le llega la sugerencia ni puede filtrar por ella', async () => {
      const ticketId = await crearTicket();
      await processor.process(await jobDeTriage(ticketId));
      const tokenViewer = await tokenConRol('VIEWER');

      try {
        const filas = await bandeja(tokenViewer);
        // La clave NO existe (no es null: null diría "sin sugerencia").
        expect(filas.every((f) => !('aiTriage' in f))).toBe(true);

        await request(app.getHttpServer())
          .get('/tickets?aiSuggestsHigher=true')
          .set('Authorization', `Bearer ${tokenViewer}`)
          .expect(403);
      } finally {
        token = await tokenConRol('ADMIN');
      }
    });

    it('un valor que no es booleano es un 400, no un "sí"', async () => {
      await request(app.getHttpServer())
        .get('/tickets?aiSuggestsHigher=yes')
        .set('Authorization', `Bearer ${token}`)
        .expect(400);
    });
  });
});
