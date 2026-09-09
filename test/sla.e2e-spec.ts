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
  SLA_QUEUE,
  TICKET_ROUTING_QUEUE,
} from '../src/infrastructure/queue/queues';
import { Role } from '../src/modules/iam/domain/role';
import { DEFAULT_SLA_POLICY } from '../src/modules/ticketing/domain/sla/sla-policy';
import { SlaProcessor } from '../src/modules/ticketing/infrastructure/queue/sla.processor';
import { SlaSweeper } from '../src/modules/ticketing/infrastructure/sla/sla-sweeper.service';
import { CLOCK, Clock } from '../src/shared-kernel';

// Esta suite hace varios logins para cambiar de rol; el rate limiting tiene su
// propia suite (`auth-rate-limit.e2e-spec.ts`).
process.env.THROTTLE_SKIP = '1';

const PASSWORD = 'un-password-seguro';
const MINUTO = 60_000;

/**
 * Reloj controlado por el test.
 *
 * El puerto `Clock` existe justo para esto (ADR-0021): un SLA de 24 horas no se
 * puede probar esperando 24 horas, y tampoco falseando `due_at` a mano en la
 * base de datos —eso probaría el barrido pero no el CÁLCULO del vencimiento—.
 * Con el reloj inyectado se ejercita la cadena entera: el ticket nace en T, los
 * relojes vencen en T+objetivo, y el barrido corre en T+25h.
 */
class RelojDePrueba implements Clock {
  private instante = new Date();

  now(): Date {
    return new Date(this.instante);
  }

  avanzarMinutos(minutos: number): void {
    this.instante = new Date(this.instante.getTime() + minutos * MINUTO);
  }
}

/**
 * Motor de SLA de punta a punta, contra Postgres y Redis reales (ADR-0020/0021).
 *
 * Igual que en `queue.e2e-spec.ts`, cada paso se pide A MANO (`publishPending`,
 * `process`, `sweep`) en vez de esperar a que salten los temporizadores: un test
 * que duerme es un test que falla una de cada veinte veces.
 */
describe('SLA (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let publisher: OutboxPublisher;
  let processor: SlaProcessor;
  let sweeper: SlaSweeper;
  let slaQueue: Queue;
  let routingQueue: Queue;

  const reloj = new RelojDePrueba();
  const run = randomUUID().slice(0, 8);
  const slug = `sla-${run}`;
  const email = `ana@sla-${run}.test`;

  let tenantId: string;
  let userId: string;
  let token: string;

  /** Ids de mensaje encolados por esta suite, para limpiar Redis al final. */
  const mensajesEncolados: string[] = [];

  // --------------------------------------------------------------- utilidades

  const crearTicket = (body: Record<string, unknown> = {}) =>
    request(app.getHttpServer())
      .post('/tickets')
      .set('Authorization', `Bearer ${token}`)
      .send({
        subject: 'No puedo entrar',
        description: 'Me da un error 500.',
        ...body,
      });

  /** Cambia el rol del usuario en la BD y devuelve un token nuevo con ese rol. */
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

  /**
   * Publica el outbox y pasa por el consumidor de SLA el evento pedido.
   *
   * Devuelve lo que respondió el processor, que es información suficiente para
   * distinguir "hizo el trabajo" de "lo ignoró a propósito".
   */
  const procesarSla = async (
    aggregateId: string,
    eventName: string,
  ): Promise<{ action: string; detail?: string }> => {
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
    mensajesEncolados.push(mensaje.id);

    return processor.process(job as Job<EventJobData>);
  };

  const timersDe = (ticketId: string) =>
    prisma.withTenant(tenantId, (tx) =>
      tx.slaTimer.findMany({
        where: { tenantId, ticketId },
        orderBy: { kind: 'asc' },
      }),
    );

  /** Crea un ticket y le arranca los relojes. Devuelve su id. */
  const ticketConSla = async (
    body: Record<string, unknown> = {},
  ): Promise<string> => {
    const res = await crearTicket(body).expect(201);
    const id = (res.body as { id: string }).id;
    await procesarSla(id, 'ticket.created');
    return id;
  };

  // ------------------------------------------------------------------- setup

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      // Sustituir el puerto, no la clase: el resto de la aplicación sigue
      // pidiendo `CLOCK` y no se entera de que el tiempo lo dirige el test.
      .overrideProvider(CLOCK)
      .useValue(reloj)
      .compile();

    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();

    prisma = app.get(PrismaService);
    publisher = app.get(OutboxPublisher);
    processor = app.get(SlaProcessor);
    sweeper = app.get(SlaSweeper);
    slaQueue = app.get<Queue>(getQueueToken(SLA_QUEUE));
    routingQueue = app.get<Queue>(getQueueToken(TICKET_ROUTING_QUEUE));

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
    // `ticket.created` va a DOS colas con el mismo jobId; se limpian las dos.
    for (const id of mensajesEncolados) {
      await slaQueue.remove(id).catch(() => undefined);
      await routingQueue.remove(id).catch(() => undefined);
    }
    await prisma.withTenant(tenantId, (tx) =>
      tx.organization.deleteMany({ where: { id: tenantId } }),
    );
    await app.close();
  });

  // ------------------------------------------------------ arranque de relojes

  describe('arranque de los relojes', () => {
    it('un ticket nuevo estrena reloj de respuesta y de resolución', async () => {
      const res = await crearTicket({ priority: 'NORMAL' }).expect(201);
      const ticketId = (res.body as { id: string }).id;
      const creadoEn = reloj.now();

      // El job no corre a la vez que la petición: pasan minutos entre que se
      // crea el ticket y que el worker lo coge.
      reloj.avanzarMinutos(10);

      const resultado = await procesarSla(ticketId, 'ticket.created');
      expect(resultado.action).toBe('started');

      const timers = await timersDe(ticketId);
      // Ordenados en JS: `ORDER BY kind` en Postgres ordena por el ORDEN DE
      // DECLARACIÓN del enum, no alfabéticamente.
      expect(timers.map((t) => t.kind).sort()).toEqual([
        'RESOLUTION',
        'RESPONSE',
      ]);

      const objetivo = DEFAULT_SLA_POLICY.NORMAL;
      for (const timer of timers) {
        // Cuenta desde que se creó el ticket, NO desde que corrió el job: si
        // contara desde el job, una cola lenta regalaría tiempo de SLA.
        expect(timer.startedAt.getTime()).toBe(creadoEn.getTime());
        expect(timer.stoppedAt).toBeNull();
        expect(timer.breachedAt).toBeNull();
      }

      const porTipo = new Map(timers.map((t) => [t.kind, t]));
      expect(porTipo.get('RESPONSE')?.dueAt.getTime()).toBe(
        creadoEn.getTime() + objetivo.responseMinutes * MINUTO,
      );
      expect(porTipo.get('RESOLUTION')?.dueAt.getTime()).toBe(
        creadoEn.getTime() + objetivo.resolutionMinutes * MINUTO,
      );
    });

    it('reprocesar el mismo evento no duplica relojes (at-least-once)', async () => {
      const ticketId = await ticketConSla();
      const antes = await timersDe(ticketId);

      const resultado = await procesarSla(ticketId, 'ticket.created');

      expect(resultado.action).toBe('skipped');
      const despues = await timersDe(ticketId);
      expect(despues).toHaveLength(antes.length);
      expect(despues.map((t) => t.id).sort()).toEqual(
        antes.map((t) => t.id).sort(),
      );
    });

    it('respeta la política que haya configurado la organización', async () => {
      await prisma.withTenant(tenantId, (tx) =>
        tx.slaPolicy.create({
          data: {
            id: randomUUID(),
            tenantId,
            priority: 'URGENT',
            responseMinutes: 5,
            resolutionMinutes: 30,
            updatedAt: reloj.now(),
          },
        }),
      );

      const res = await crearTicket({ priority: 'URGENT' }).expect(201);
      const ticketId = (res.body as { id: string }).id;
      const creadoEn = reloj.now();
      await procesarSla(ticketId, 'ticket.created');

      const timers = await timersDe(ticketId);
      const porTipo = new Map(timers.map((t) => [t.kind, t]));
      expect(porTipo.get('RESPONSE')?.dueAt.getTime()).toBe(
        creadoEn.getTime() + 5 * MINUTO,
      );
      expect(porTipo.get('RESOLUTION')?.dueAt.getTime()).toBe(
        creadoEn.getTime() + 30 * MINUTO,
      );
    });

    it('las prioridades no configuradas siguen usando el valor por defecto', async () => {
      // El merge es POR PRIORIDAD: haber endurecido `URGENT` no deja a `HIGH`
      // sin SLA ni obliga a declarar las cuatro.
      const res = await crearTicket({ priority: 'HIGH' }).expect(201);
      const ticketId = (res.body as { id: string }).id;
      const creadoEn = reloj.now();
      await procesarSla(ticketId, 'ticket.created');

      const timers = await timersDe(ticketId);
      const respuesta = timers.find((t) => t.kind === 'RESPONSE');
      expect(respuesta?.dueAt.getTime()).toBe(
        creadoEn.getTime() + DEFAULT_SLA_POLICY.HIGH.responseMinutes * MINUTO,
      );
    });
  });

  // ------------------------------------------------------- parada de relojes

  describe('parada de los relojes', () => {
    let ticketId: string;

    beforeAll(async () => {
      ticketId = await ticketConSla({ subject: 'Con conversación' });
    });

    it('el comentario del solicitante NO para el reloj de respuesta', async () => {
      const tokenViewer = await tokenConRol('VIEWER');
      await request(app.getHttpServer())
        .post(`/tickets/${ticketId}/comments`)
        .set('Authorization', `Bearer ${tokenViewer}`)
        .send({ body: '¿Hay alguien ahí?' })
        .expect(201);

      const resultado = await procesarSla(ticketId, 'comment.added');

      expect(resultado.action).toBe('ignored');
      const timers = await timersDe(ticketId);
      expect(timers.find((t) => t.kind === 'RESPONSE')?.stoppedAt).toBeNull();
    });

    it('el comentario de un agente sí lo para, con la hora del comentario', async () => {
      token = await tokenConRol('ADMIN');
      reloj.avanzarMinutos(30);
      const respondidoEn = reloj.now();

      await request(app.getHttpServer())
        .post(`/tickets/${ticketId}/comments`)
        .set('Authorization', `Bearer ${token}`)
        .send({ body: 'Lo estamos mirando.' })
        .expect(201);

      // El job corre más tarde que el comentario; el reloj se para con la hora
      // del COMENTARIO, o un SLA cumplido por los pelos se contaría incumplido.
      reloj.avanzarMinutos(5);
      const resultado = await procesarSla(ticketId, 'comment.added');

      expect(resultado.action).toBe('stopped');
      const timers = await timersDe(ticketId);
      expect(timers.find((t) => t.kind === 'RESPONSE')?.stoppedAt).toEqual(
        respondidoEn,
      );
      // El de resolución sigue corriendo: contestar no es arreglar.
      expect(timers.find((t) => t.kind === 'RESOLUTION')?.stoppedAt).toBeNull();
    });

    it('pasar a IN_PROGRESS no para el reloj de resolución', async () => {
      await request(app.getHttpServer())
        .patch(`/tickets/${ticketId}/status`)
        .set('Authorization', `Bearer ${token}`)
        .send({ status: 'IN_PROGRESS' })
        .expect(200);

      const resultado = await procesarSla(ticketId, 'ticket.status_changed');

      expect(resultado.action).toBe('ignored');
      const timers = await timersDe(ticketId);
      expect(timers.find((t) => t.kind === 'RESOLUTION')?.stoppedAt).toBeNull();
    });

    it('resolver el ticket para el reloj de resolución', async () => {
      reloj.avanzarMinutos(45);
      const resueltoEn = reloj.now();

      await request(app.getHttpServer())
        .patch(`/tickets/${ticketId}/status`)
        .set('Authorization', `Bearer ${token}`)
        .send({ status: 'RESOLVED' })
        .expect(200);

      const resultado = await procesarSla(ticketId, 'ticket.status_changed');

      expect(resultado.action).toBe('stopped');
      const timers = await timersDe(ticketId);
      expect(timers.find((t) => t.kind === 'RESOLUTION')?.stoppedAt).toEqual(
        resueltoEn,
      );
      expect(timers.every((t) => t.breachedAt === null)).toBe(true);
    });
  });

  // -------------------------------------------------------------- el barrido

  describe('barrido de incumplimientos', () => {
    let ticketId: string;
    let cumplidoId: string;

    beforeAll(async () => {
      ticketId = await ticketConSla({ subject: 'Nadie lo mira' });

      // Un ticket que SÍ se atiende a tiempo, para comprobar que el barrido no
      // se lo lleva por delante.
      cumplidoId = await ticketConSla({ subject: 'Atendido a tiempo' });
      await request(app.getHttpServer())
        .post(`/tickets/${cumplidoId}/comments`)
        .set('Authorization', `Bearer ${token}`)
        .send({ body: 'Respondido enseguida.' })
        .expect(201);
      await procesarSla(cumplidoId, 'comment.added');
    });

    it('marca como incumplidos los relojes vencidos', async () => {
      // Más allá del objetivo de resolución por defecto (24 h), así que vencen
      // los dos relojes del ticket abandonado.
      reloj.avanzarMinutos(25 * 60);

      const incumplidos = await sweeper.sweep(reloj.now());
      expect(incumplidos).toBeGreaterThanOrEqual(2);

      const timers = await timersDe(ticketId);
      expect(timers).toHaveLength(2);
      for (const timer of timers) {
        expect(timer.breachedAt).not.toBeNull();
        expect(timer.stoppedAt).toBeNull();
      }
    });

    it('no toca los relojes que se pararon a tiempo', async () => {
      const timers = await timersDe(cumplidoId);
      const respuesta = timers.find((t) => t.kind === 'RESPONSE');

      // Se paró antes de vencer, así que el barrido lo encontró ya parado —de
      // hecho ni lo ve: `sla_due_timers` filtra por `stopped_at IS NULL`.
      expect(respuesta?.stoppedAt).not.toBeNull();
      expect(respuesta?.breachedAt).toBeNull();
    });

    it('deja el incumplimiento auditado a nombre del sistema', async () => {
      const historial = await prisma.withTenant(tenantId, (tx) =>
        tx.auditLog.findMany({
          where: { tenantId, entityId: ticketId, action: 'sla.breached' },
        }),
      );

      expect(historial).toHaveLength(2);
      expect(historial[0].actorId).toBe('00000000-0000-0000-0000-000000000000');
      expect(historial[0].metadata).toMatchObject({ automatic: true });
      // Se registra con la hora en que DEBÍA haberse cumplido, no con la del
      // barrido: el retraso real se mide contra el objetivo.
      expect(historial[0].metadata).toHaveProperty('dueAt');
    });

    it('publica un evento de dominio por cada incumplimiento', async () => {
      const eventos = await prisma.withTenant(tenantId, (tx) =>
        tx.outboxMessage.findMany({
          where: { tenantId, aggregateId: ticketId, eventName: 'sla.breached' },
        }),
      );

      expect(eventos).toHaveLength(2);
      // El evento sale del TICKET, no del temporizador: quien escale mañana
      // necesita la prioridad y el asignado, no solo que un reloj venció.
      expect(eventos[0].payload).toMatchObject({ priority: 'NORMAL' });
    });

    it('un segundo barrido no vuelve a marcar lo ya marcado', async () => {
      const antes = await timersDe(ticketId);

      await sweeper.sweep(reloj.now());

      const despues = await timersDe(ticketId);
      expect(despues.map((t) => t.breachedAt)).toEqual(
        antes.map((t) => t.breachedAt),
      );
      // Y no se duplicó ni la auditoría ni el evento.
      const eventos = await prisma.withTenant(tenantId, (tx) =>
        tx.outboxMessage.count({
          where: { tenantId, aggregateId: ticketId, eventName: 'sla.breached' },
        }),
      );
      expect(eventos).toBe(2);
    });
  });
});
