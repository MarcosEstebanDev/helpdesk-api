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
import { Role } from '../src/modules/iam/domain/role';
import {
  SlaTimerId,
  TenantId,
  TicketId,
} from '../src/modules/ticketing/domain/ids';
import { DEFAULT_SLA_POLICY } from '../src/modules/ticketing/domain/sla/sla-policy';
import { SlaTimer } from '../src/modules/ticketing/domain/sla/sla-timer.entity';
import { SYSTEM_ACTOR_ID } from '../src/modules/ticketing/domain/system-actor';
import { PrismaSlaTimerRepository } from '../src/modules/ticketing/infrastructure/persistence/prisma-sla.repository';
import { SlaProcessor } from '../src/modules/ticketing/infrastructure/queue/sla.processor';
import { SlaSweeper } from '../src/modules/ticketing/infrastructure/sla/sla-sweeper.service';
import { CLOCK, Clock } from '../src/shared-kernel';

// Varios logins para cambiar de rol; el rate limiting tiene su propia suite.
process.env.THROTTLE_SKIP = '1';

const PASSWORD = 'un-password-seguro';
const MINUTO = 60_000;
const RESOLUCION_NORMAL = DEFAULT_SLA_POLICY.NORMAL.resolutionMinutes;

/** Reloj controlado por el test (mismo patrón que `sla.e2e-spec.ts`). */
class RelojDePrueba implements Clock {
  private instante = new Date();

  now(): Date {
    return new Date(this.instante);
  }

  avanzarMinutos(minutos: number): void {
    this.instante = new Date(this.instante.getTime() + minutos * MINUTO);
  }
}

interface SlaEnLaVista {
  kind: string;
  status: string;
  remainingMinutes: number;
  pausedAt: string | null;
}

/**
 * Pausa del SLA de punta a punta (ADR-0029), contra Postgres y Redis reales.
 *
 * La pausa y la reanudación ocurren en la TRANSACCIÓN del cambio de estado, así
 * que basta con la petición HTTP para verlas en `sla_timers`; la cola `sla` solo
 * hace falta para arrancar los relojes y para parar el de resolución.
 *
 * Se avanza el reloj entre acciones: `procesarSla` toma el último evento por
 * `occurredAt`, y dos eventos con la misma hora empatan. Por la misma razón no
 * se depende del orden entre `comment.added` y el `status_changed` automático,
 * que salen con el mismo instante.
 */
describe('Pausa del SLA (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let publisher: OutboxPublisher;
  let processor: SlaProcessor;
  let sweeper: SlaSweeper;
  let slaQueue: Queue;
  let routingQueue: Queue;

  const reloj = new RelojDePrueba();
  const run = randomUUID().slice(0, 8);
  const slug = `pausa-${run}`;
  const email = `ana@pausa-${run}.test`;

  let tenantId: string;
  let userId: string;
  let token: string;

  const mensajesEncolados: string[] = [];

  // --------------------------------------------------------------- utilidades

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

  const resolucionDe = async (ticketId: string) => {
    const timer = await prisma.withTenant(tenantId, (tx) =>
      tx.slaTimer.findFirst({
        where: { tenantId, ticketId, kind: 'RESOLUTION' },
      }),
    );
    if (timer === null) throw new Error('sin reloj de resolución');
    return timer;
  };

  /** Ticket NORMAL con sus relojes y ya en IN_PROGRESS. */
  const ticketEnCurso = async (subject: string): Promise<string> => {
    const res = await request(app.getHttpServer())
      .post('/tickets')
      .set('Authorization', `Bearer ${token}`)
      .send({ subject, description: 'Algo no anda.', priority: 'NORMAL' })
      .expect(201);
    const id = (res.body as { id: string }).id;
    await procesarSla(id, 'ticket.created');
    reloj.avanzarMinutos(1);
    await cambiarEstado(id, 'IN_PROGRESS').expect(200);
    reloj.avanzarMinutos(1);
    return id;
  };

  const cambiarEstado = (id: string, status: string, tk = token) =>
    request(app.getHttpServer())
      .patch(`/tickets/${id}/status`)
      .set('Authorization', `Bearer ${tk}`)
      .send({ status });

  const comentar = (
    id: string,
    body: string,
    tk = token,
    visibility: 'PUBLIC' | 'INTERNAL' = 'PUBLIC',
  ) =>
    request(app.getHttpServer())
      .post(`/tickets/${id}/comments`)
      .set('Authorization', `Bearer ${tk}`)
      .send({ body, visibility });

  const detalle = async (id: string) => {
    const res = await request(app.getHttpServer())
      .get(`/tickets/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    return res.body as { status: string; sla: SlaEnLaVista[] };
  };

  // ------------------------------------------------------------------- setup

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
    for (const id of mensajesEncolados) {
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

  // --------------------------------------------- repositorio y barrido (Task 5)

  describe('escrituras condicionadas y barrido', () => {
    it('transition solo escribe si la fila sigue en el estado esperado', async () => {
      const id = await ticketEnCurso('Repo condicionado');
      const repo = app.get(PrismaSlaTimerRepository);
      const fila = await resolucionDe(id);
      const timer = SlaTimer.rehydrate({
        id: SlaTimerId(fila.id),
        tenantId: TenantId(tenantId),
        ticketId: TicketId(id),
        kind: 'RESOLUTION',
        startedAt: fila.startedAt,
        dueAt: fila.dueAt,
        stoppedAt: null,
        breachedAt: null,
        pausedAt: null,
      });
      timer.pause(reloj.now());

      expect(await repo.transition(timer, 'running')).toBe(true);
      // La fila ya está pausada: una segunda escritura "desde corriendo" pierde.
      expect(await repo.transition(timer, 'running')).toBe(false);

      // Incumplir un reloj que en la BD está pausado no toca la fila.
      const incumplido = SlaTimer.rehydrate({
        id: SlaTimerId(fila.id),
        tenantId: TenantId(tenantId),
        ticketId: TicketId(id),
        kind: 'RESOLUTION',
        startedAt: fila.startedAt,
        dueAt: fila.dueAt,
        stoppedAt: null,
        breachedAt: null,
        pausedAt: null,
      });
      incumplido.markBreached(reloj.now());
      expect(await repo.transition(incumplido, 'running')).toBe(false);
      expect((await resolucionDe(id)).breachedAt).toBeNull();

      expect(
        (
          await repo.findOpen(TenantId(tenantId), TicketId(id), 'RESOLUTION')
        )?.isPaused(),
      ).toBe(true);
    });

    it('sla_due_timers no devuelve relojes en pausa aunque hayan vencido', async () => {
      const id = await ticketEnCurso('Barrido y pausa');
      await cambiarEstado(id, 'WAITING_ON_CUSTOMER').expect(200);
      const fila = await resolucionDe(id);

      // Se llama como la llama el barrido: como `helpdesk_app`, sin tenant.
      const vencidos = await prisma.$queryRaw<{ id: string }[]>`
        SELECT id FROM sla_due_timers(${100000}::int, ${new Date(
          fila.dueAt.getTime() + 60 * MINUTO,
        )}::timestamp(3))`;

      expect(vencidos.map((v) => v.id)).not.toContain(fila.id);
    });
  });

  // -------------------------------------------------------------- escenarios

  it('el barrido no incumple en espera y el comentario del cliente lo reanuda', async () => {
    const id = await ticketEnCurso('Le pedimos una captura');
    const vencimientoOriginal = (await resolucionDe(id)).dueAt;

    await cambiarEstado(id, 'WAITING_ON_CUSTOMER').expect(200);
    const pausaEn = reloj.now();
    expect((await resolucionDe(id)).pausedAt).toEqual(pausaEn);
    // La pausa NO es del consumidor: el evento le llega y lo ignora.
    expect((await procesarSla(id, 'ticket.status_changed')).action).toBe(
      'ignored',
    );

    // Mucho más allá del vencimiento original: el barrido no lo toca.
    reloj.avanzarMinutos(RESOLUCION_NORMAL + 60);
    await sweeper.sweep(reloj.now());
    const enPausa = await resolucionDe(id);
    expect(enPausa.breachedAt).toBeNull();
    expect(enPausa.pausedAt).toEqual(pausaEn);
    const vista = (await detalle(id)).sla.find((s) => s.kind === 'RESOLUTION');
    expect(vista?.status).toBe('paused');

    // Contesta el cliente.
    const tokenViewer = await tokenConRol('VIEWER');
    reloj.avanzarMinutos(1);
    const reanudaEn = reloj.now();
    await comentar(id, 'Ahí va la captura.', tokenViewer).expect(201);
    token = await tokenConRol('ADMIN');

    expect((await detalle(id)).status).toBe('IN_PROGRESS');
    const reanudado = await resolucionDe(id);
    expect(reanudado.pausedAt).toBeNull();
    expect(reanudado.dueAt.getTime()).toBe(
      vencimientoOriginal.getTime() + (reanudaEn.getTime() - pausaEn.getTime()),
    );

    // Pasado el vencimiento NUEVO, sí incumple.
    reloj.avanzarMinutos(
      Math.ceil((reanudado.dueAt.getTime() - reloj.now().getTime()) / MINUTO) +
        1,
    );
    await sweeper.sweep(reloj.now());
    expect((await resolucionDe(id)).breachedAt).not.toBeNull();
  });

  it('resolver desde la espera para el reloj y el margen descuenta la pausa', async () => {
    const id = await ticketEnCurso('Se arregló solo');
    const vencimientoOriginal = (await resolucionDe(id)).dueAt;

    await cambiarEstado(id, 'WAITING_ON_CUSTOMER').expect(200);
    reloj.avanzarMinutos(30);
    const resueltoEn = reloj.now();
    await cambiarEstado(id, 'RESOLVED').expect(200);

    expect((await procesarSla(id, 'ticket.status_changed')).action).toBe(
      'stopped',
    );
    const parado = await resolucionDe(id);
    expect(parado.stoppedAt).toEqual(resueltoEn);
    expect(parado.pausedAt).toBeNull();
    expect(parado.dueAt.getTime()).toBe(
      vencimientoOriginal.getTime() + 30 * MINUTO,
    );
    const vista = (await detalle(id)).sla.find((s) => s.kind === 'RESOLUTION');
    expect(vista?.status).toBe('met');
  });

  it('ni una nota interna ni un comentario del equipo lo sacan de la espera', async () => {
    const id = await ticketEnCurso('Esperando datos');
    await cambiarEstado(id, 'WAITING_ON_CUSTOMER').expect(200);

    reloj.avanzarMinutos(1);
    await comentar(id, 'Lo sigo mañana.', token, 'INTERNAL').expect(201);
    reloj.avanzarMinutos(1);
    await comentar(id, '¿Pudiste mirar lo que te pedí?', token).expect(201);

    expect((await detalle(id)).status).toBe('WAITING_ON_CUSTOMER');
    expect((await resolucionDe(id)).pausedAt).not.toBeNull();
  });

  it('espera → retomar → espera: el tramo trabajado SÍ cuenta', async () => {
    const id = await ticketEnCurso('Ida y vuelta');
    const vencimientoOriginal = (await resolucionDe(id)).dueAt;

    await cambiarEstado(id, 'WAITING_ON_CUSTOMER').expect(200);
    reloj.avanzarMinutos(5);
    await cambiarEstado(id, 'IN_PROGRESS').expect(200);
    reloj.avanzarMinutos(1);
    await cambiarEstado(id, 'WAITING_ON_CUSTOMER').expect(200);
    reloj.avanzarMinutos(60);
    await cambiarEstado(id, 'IN_PROGRESS').expect(200);

    // 5 + 60 minutos de pausa; el minuto de trabajo cuenta.
    expect((await resolucionDe(id)).dueAt.getTime()).toBe(
      vencimientoOriginal.getTime() + 65 * MINUTO,
    );
  });

  it('desde la espera no se cierra ni se devuelve a la cola, y un VIEWER no la usa', async () => {
    const id = await ticketEnCurso('Transiciones prohibidas');
    await cambiarEstado(id, 'WAITING_ON_CUSTOMER').expect(200);

    await cambiarEstado(id, 'CLOSED').expect(409);
    await cambiarEstado(id, 'OPEN').expect(409);

    const tokenViewer = await tokenConRol('VIEWER');
    await cambiarEstado(id, 'IN_PROGRESS', tokenViewer).expect(403);
    token = await tokenConRol('ADMIN');
  });

  it('el historial muestra la vuelta automática a nombre del sistema', async () => {
    const id = await ticketEnCurso('Historial');
    await cambiarEstado(id, 'WAITING_ON_CUSTOMER').expect(200);

    const tokenViewer = await tokenConRol('VIEWER');
    reloj.avanzarMinutos(1);
    await comentar(id, 'Ya lo probé.', tokenViewer).expect(201);
    token = await tokenConRol('ADMIN');

    const res = await request(app.getHttpServer())
      .get(`/tickets/${id}/history`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const entradas = res.body as {
      action: string;
      actorId: string;
      metadata: Record<string, unknown> | null;
    }[];
    const automatica = entradas.find(
      (e) => e.action === 'ticket.status_changed' && e.metadata?.automatic,
    );

    expect(automatica?.actorId).toBe(SYSTEM_ACTOR_ID);
    expect(automatica?.metadata).toMatchObject({
      from: 'WAITING_ON_CUSTOMER',
      to: 'IN_PROGRESS',
      trigger: 'customer_reply',
    });
  });
});
