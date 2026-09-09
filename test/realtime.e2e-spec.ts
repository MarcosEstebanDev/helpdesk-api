import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { INestApplication } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { Test, TestingModule } from '@nestjs/testing';
import { Queue } from 'bullmq';
import type { Job } from 'bullmq';
import request from 'supertest';
import { App } from 'supertest/types';
import { io, type Socket as ClientSocket } from 'socket.io-client';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import type { EventJobData } from '../src/infrastructure/outbox/outbox-publisher.service';
import { OutboxPublisher } from '../src/infrastructure/outbox/outbox-publisher.service';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import { attachRealtimeAdapter } from '../src/infrastructure/realtime/redis-io.adapter';
import {
  REALTIME_QUEUE,
  SLA_QUEUE,
  TICKET_ROUTING_QUEUE,
} from '../src/infrastructure/queue/queues';
import { Role } from '../src/modules/iam/domain/role';
import { RealtimeProcessor } from '../src/modules/ticketing/infrastructure/queue/realtime.processor';
import {
  REALTIME_PUBLISHER,
  type RealtimePublisher,
} from '../src/shared-kernel';

process.env.THROTTLE_SKIP = '1';

const PASSWORD = 'un-password-seguro';

interface Organizacion {
  slug: string;
  email: string;
  tenantId: string;
  userId: string;
  token: string;
}

/**
 * Tiempo real de punta a punta, con clientes Socket.io de verdad (ADR-0022/0023).
 *
 * El test estrella es el equivalente WebSocket de `rls-isolation.e2e-spec.ts`:
 * fuera del ciclo request/response no hay RLS cubriendo las espaldas, así que
 * el aislamiento entre organizaciones depende por completo de en qué room acabó
 * cada socket. Si eso se rompe, no falla nada — simplemente un tenant empieza a
 * ver los tickets de otro.
 */
describe('Realtime (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let publisher: OutboxPublisher;
  let processor: RealtimeProcessor;
  let realtimeQueue: Queue;
  let slaQueue: Queue;
  let routingQueue: Queue;
  let url: string;

  const run = randomUUID().slice(0, 8);
  let acme: Organizacion;
  let otra: Organizacion;

  const sockets: ClientSocket[] = [];
  const mensajesEncolados: string[] = [];

  // --------------------------------------------------------------- utilidades

  const claimsDe = (token: string): { sub: string; tenantId: string } =>
    JSON.parse(
      Buffer.from(token.split('.')[1], 'base64url').toString('utf8'),
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

  /** Conecta un cliente y espera a que el handshake termine bien. */
  const conectar = async (token: string): Promise<ClientSocket> => {
    const socket = io(url, {
      auth: { token },
      transports: ['websocket'],
      reconnection: false,
    });
    sockets.push(socket);

    await new Promise<void>((resolve, reject) => {
      const fallo = setTimeout(() => reject(new Error('no conectó')), 5000);
      socket.once('connect', () => {
        clearTimeout(fallo);
        resolve();
      });
      socket.once('connect_error', (e) => {
        clearTimeout(fallo);
        reject(e);
      });
    });
    return socket;
  };

  const esperar = <T>(
    socket: ClientSocket,
    evento: string,
    ms = 5000,
  ): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const fallo = setTimeout(
        () => reject(new Error(`no llegó "${evento}"`)),
        ms,
      );
      socket.once(evento, (data: T) => {
        clearTimeout(fallo);
        resolve(data);
      });
    });

  /** Registra lo que llegue a ese socket, para poder afirmar que NO llegó nada. */
  const grabar = (
    socket: ClientSocket,
    evento: string,
  ): { recibidos: unknown[] } => {
    const buzon: { recibidos: unknown[] } = { recibidos: [] };
    socket.on(evento, (data: unknown) => buzon.recibidos.push(data));
    return buzon;
  };

  const crearTicket = (token: string, body: Record<string, unknown> = {}) =>
    request(app.getHttpServer())
      .post('/tickets')
      .set('Authorization', `Bearer ${token}`)
      .send({
        subject: 'No puedo entrar',
        description: 'Me da un error 500.',
        ...body,
      });

  /**
   * Publica el outbox y pasa por el consumidor de realtime el evento pedido.
   * Los workers están apagados en los e2e, así que cada paso se pide a mano.
   */
  const emitir = async (
    tenantId: string,
    aggregateId: string,
    eventName: string,
  ): Promise<void> => {
    await publisher.publishPending();

    const mensaje = await prisma.withTenant(tenantId, (tx) =>
      tx.outboxMessage.findFirst({
        where: { tenantId, aggregateId, eventName },
        orderBy: { occurredAt: 'desc' },
      }),
    );
    if (mensaje === null) throw new Error(`sin mensaje ${eventName}`);

    const job = await realtimeQueue.getJob(mensaje.id);
    if (job === undefined) throw new Error(`sin job para ${eventName}`);
    mensajesEncolados.push(mensaje.id);

    await processor.process(job as Job<EventJobData>);
  };

  // ------------------------------------------------------------------- setup

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    configureApp(app);
    // El mismo adapter que usa producción: si las rooms no funcionaran a través
    // de Redis, este test no se enteraría montando el adapter por defecto.
    await attachRealtimeAdapter(app);
    // Puerto 0 = el sistema elige uno libre; hace falta escuchar de verdad
    // porque un cliente Socket.io abre su propia conexión.
    await app.listen(0);

    // El tipo `App` de supertest no expone `address()`, que sí tiene el servidor
    // HTTP de Node que hay debajo.
    const server = app.getHttpServer() as unknown as {
      address(): AddressInfo;
    };
    url = `http://127.0.0.1:${server.address().port}`;

    prisma = app.get(PrismaService);
    publisher = app.get(OutboxPublisher);
    processor = app.get(RealtimeProcessor);
    realtimeQueue = app.get<Queue>(getQueueToken(REALTIME_QUEUE));
    slaQueue = app.get<Queue>(getQueueToken(SLA_QUEUE));
    routingQueue = app.get<Queue>(getQueueToken(TICKET_ROUTING_QUEUE));

    acme = await registrar(`acme-rt-${run}`);
    otra = await registrar(`otra-rt-${run}`);
  });

  afterAll(async () => {
    for (const socket of sockets) socket.disconnect();

    // El mismo evento se encola en varias colas con el mismo jobId.
    for (const id of mensajesEncolados) {
      await realtimeQueue.remove(id).catch(() => undefined);
      await slaQueue.remove(id).catch(() => undefined);
      await routingQueue.remove(id).catch(() => undefined);
    }
    for (const org of [acme, otra]) {
      await prisma.withTenant(org.tenantId, (tx) =>
        tx.organization.deleteMany({ where: { id: org.tenantId } }),
      );
    }
    await app.close();
  });

  // ------------------------------------------------------------- handshake

  describe('handshake', () => {
    it('sin token no se entra', async () => {
      const socket = io(url, {
        transports: ['websocket'],
        reconnection: false,
      });
      sockets.push(socket);

      const motivo = await new Promise<{ reason: string }>(
        (resolve, reject) => {
          const fallo = setTimeout(() => reject(new Error('no cerró')), 5000);
          socket.once('disconnected', (data: { reason: string }) => {
            clearTimeout(fallo);
            resolve(data);
          });
        },
      );

      expect(motivo.reason).toBe('unauthorized');
    });

    it('un token inventado tampoco', async () => {
      const socket = io(url, {
        auth: { token: 'esto.no.es-un-jwt' },
        transports: ['websocket'],
        reconnection: false,
      });
      sockets.push(socket);

      const motivo = await new Promise<{ reason: string }>(
        (resolve, reject) => {
          const fallo = setTimeout(() => reject(new Error('no cerró')), 5000);
          socket.once('disconnected', (data: { reason: string }) => {
            clearTimeout(fallo);
            resolve(data);
          });
        },
      );

      expect(motivo.reason).toBe('unauthorized');
    });
  });

  // ---------------------------------------------------- aislamiento (estrella)

  describe('aislamiento entre organizaciones', () => {
    it('un ticket de una organización no llega a la otra', async () => {
      const deAcme = await conectar(acme.token);
      const deOtra = await conectar(otra.token);
      const buzonAjeno = grabar(deOtra, 'ticket.created');

      const res = await crearTicket(acme.token, {
        subject: 'Secreto de Acme',
      }).expect(201);
      const ticketId = (res.body as { id: string }).id;

      const recibido = esperar<{ ticketId: string; subject: string }>(
        deAcme,
        'ticket.created',
      );
      await emitir(acme.tenantId, ticketId, 'ticket.created');

      const aviso = await recibido;
      expect(aviso.ticketId).toBe(ticketId);
      expect(aviso.subject).toBe('Secreto de Acme');

      // Se comprueba DESPUÉS de que el destinatario legítimo haya recibido: así
      // no se está midiendo una carrera, sino un mensaje que ya se entregó.
      expect(buzonAjeno.recibidos).toHaveLength(0);
    });
  });

  // ------------------------------------------------------- filtrado por rol

  describe('filtrado por rol', () => {
    it('lo del equipo no llega a quien solo abre tickets', async () => {
      // Se emite por el PUERTO directamente: lo que se prueba aquí es el
      // gateway —quién está en qué room—, no el motor que genera el evento.
      const staffToken = await tokenConRol(otra, 'ADMIN');
      const viewerOrg = await registrar(`viewer-rt-${run}`);
      const viewerToken = await tokenConRol(viewerOrg, 'VIEWER');

      const delEquipo = await conectar(staffToken);
      const delCliente = await conectar(viewerToken);
      const buzonCliente = grabar(delCliente, 'sla.breached');

      const realtime = app.get<RealtimePublisher>(REALTIME_PUBLISHER);
      const recibido = esperar<{ kind: string }>(delEquipo, 'sla.breached');

      await realtime.publish(
        { scope: 'staff', tenantId: otra.tenantId },
        { event: 'sla.breached', payload: { kind: 'RESPONSE' } },
      );

      expect((await recibido).kind).toBe('RESPONSE');
      expect(buzonCliente.recibidos).toHaveLength(0);

      await prisma.withTenant(viewerOrg.tenantId, (tx) =>
        tx.organization.deleteMany({ where: { id: viewerOrg.tenantId } }),
      );
    });
  });

  // ---------------------------------------------------------- room de ticket

  describe('seguimiento de un ticket', () => {
    it('solo recibe el detalle quien lo está mirando', async () => {
      const mirando = await conectar(acme.token);
      const noMirando = await conectar(acme.token);
      const buzon = grabar(noMirando, 'comment.added');

      const res = await crearTicket(acme.token, {
        subject: 'Con conversación',
      }).expect(201);
      const ticketId = (res.body as { id: string }).id;

      const confirmacion = await mirando.emitWithAck('ticket:watch', ticketId);
      expect(confirmacion).toEqual({ watching: ticketId });

      await request(app.getHttpServer())
        .post(`/tickets/${ticketId}/comments`)
        .set('Authorization', `Bearer ${acme.token}`)
        .send({ body: 'Lo estamos mirando.' })
        .expect(201);

      const recibido = esperar<{ commentId: string }>(mirando, 'comment.added');
      await emitir(acme.tenantId, ticketId, 'comment.added');

      const aviso = await recibido;
      expect(aviso).toHaveProperty('commentId');
      // El cuerpo NO viaja: quien lo quiera, lo recarga con sus permisos.
      expect(aviso).not.toHaveProperty('body');
      expect(buzon.recibidos).toHaveLength(0);
    });

    it('seguir un ticket de otra organización no da acceso a nada', async () => {
      // El room se construye con el tenant DEL TOKEN, así que pedir un id ajeno
      // mete al socket en una room vacía en vez de en la del vecino.
      const intruso = await conectar(otra.token);

      const res = await crearTicket(acme.token, {
        subject: 'Solo para Acme',
      }).expect(201);
      const ticketId = (res.body as { id: string }).id;

      await intruso.emitWithAck('ticket:watch', ticketId);
      const buzon = grabar(intruso, 'ticket.status_changed');

      const dueno = await conectar(acme.token);
      await dueno.emitWithAck('ticket:watch', ticketId);
      const recibido = esperar(dueno, 'ticket.status_changed');

      await request(app.getHttpServer())
        .patch(`/tickets/${ticketId}/status`)
        .set('Authorization', `Bearer ${acme.token}`)
        .send({ status: 'IN_PROGRESS' })
        .expect(200);
      await emitir(acme.tenantId, ticketId, 'ticket.status_changed');

      await recibido;
      expect(buzon.recibidos).toHaveLength(0);
    });
  });
});
