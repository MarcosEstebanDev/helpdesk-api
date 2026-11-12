import { Ticket } from '../domain/entities/ticket.entity';
import { SlaTimerId, TicketId } from '../domain/ids';
import { CALENDAR_24_7 } from '../domain/sla/sla-calendar';
import { SlaTimer } from '../domain/sla/sla-timer.entity';
import { SYSTEM_ACTOR_ID } from '../domain/system-actor';
import { TicketStatus } from '../domain/ticket-status';
import { AddComment } from './add-comment.use-case';
import { AuditRecorder } from './audit-recorder';
import { EventRecorder } from './event-recorder';
import { SlaPauseCoordinator } from './sla/sla-pause-coordinator';
import {
  ACTOR,
  AHORA,
  TENANT,
  fakeAuditLogRepository,
  fakeCommentRepository,
  fakeOutbox,
  fakeSlaTimers,
  fakeTicketRepository,
  fakeTransactions,
  fixedClock,
  sequentialIds,
} from './ticketing.test-doubles';

const TICKET_ID = TicketId('44444444-4444-4444-4444-444444444444');
const ANTES = new Date('2026-09-09T08:00:00Z');
const RELOJ = SlaTimerId('66666666-6666-6666-6666-666666666666');

const nuevoTicket = (
  cerrado = false,
  estados: readonly TicketStatus[] = [],
): Ticket => {
  const created = Ticket.open({
    id: TICKET_ID,
    tenantId: TENANT,
    number: 7,
    subject: 'No puedo entrar',
    description: 'Error 500.',
    priority: 'NORMAL',
    requesterId: ACTOR,
    now: ANTES,
  });
  if (created.isErr()) throw new Error('el ticket debería haberse creado');

  if (cerrado) {
    created.value.changeStatus('RESOLVED', ANTES);
    created.value.changeStatus('CLOSED', ANTES);
  }
  for (const destino of estados) created.value.changeStatus(destino, ANTES);
  // Se descartan los eventos de la creación: un ticket que viene del
  // repositorio se REHIDRATA, así que no arrastra el `ticket.created` que ya se
  // publicó en su día. Sin esto el doble mentiría respecto a producción.
  created.value.pullDomainEvents();
  return created.value;
};

const buildSut = (semilla: Ticket) => {
  const transactions = fakeTransactions();
  const tickets = fakeTicketRepository();
  tickets.seed(semilla);
  const comments = fakeCommentRepository();
  const auditLogs = fakeAuditLogRepository();
  const ids = sequentialIds();
  const audit = new AuditRecorder(ids, auditLogs);
  const outbox = fakeOutbox();

  // Reloj de resolución ya en pausa desde ANTES, por si el ticket está en la
  // espera; si no lo está, nadie lo mira (ADR-0029).
  const timers = fakeSlaTimers();
  const reloj = SlaTimer.start({
    id: RELOJ,
    tenantId: TENANT,
    ticketId: TICKET_ID,
    kind: 'RESOLUTION',
    minutes: 24 * 60,
    calendar: CALENDAR_24_7,
    now: ANTES,
  });
  if (semilla.status === 'WAITING_ON_CUSTOMER') reloj.pause(ANTES);
  timers.seed(reloj);

  const sut = new AddComment(
    transactions.manager,
    tickets,
    comments,
    audit,
    new EventRecorder(ids, outbox),
    ids,
    fixedClock(),
    new SlaPauseCoordinator(timers),
  );

  return { sut, transactions, comments, auditLogs, outbox, timers };
};

describe('AddComment', () => {
  it('guarda el comentario y lo audita en la misma transacción', async () => {
    const { sut, transactions, comments, auditLogs } = buildSut(nuevoTicket());

    const result = await sut.execute({
      tenantId: TENANT,
      actorId: ACTOR,
      actorRole: 'AGENT',
      ticketId: TICKET_ID,
      visibility: 'PUBLIC',
      body: '  Ya lo estamos mirando.  ',
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      // El dominio recorta: el cuerpo se guarda limpio.
      expect(result.value.body).toBe('Ya lo estamos mirando.');
      expect(result.value.authorId).toBe(ACTOR);
      expect(result.value.createdAt).toBe(AHORA);
    }
    expect(comments.comments).toHaveLength(1);
    expect(auditLogs.entries[0].action).toBe('comment.added');
    // La auditoría se ancla al TICKET, no al comentario: así el historial del
    // ticket incluye su conversación sin tener que cruzar dos consultas.
    expect(auditLogs.entries[0].entityId).toBe(TICKET_ID);
    expect(transactions.commits).toBe(1);
  });

  it('publica comment.added desde la raíz del agregado', async () => {
    const { sut, outbox } = buildSut(nuevoTicket());

    const result = await sut.execute({
      tenantId: TENANT,
      actorId: ACTOR,
      actorRole: 'AGENT',
      ticketId: TICKET_ID,
      visibility: 'PUBLIC',
      body: 'Ya lo estamos mirando.',
    });

    expect(outbox.records).toHaveLength(1);
    const evento = outbox.records[0];
    expect(evento.eventName).toBe('comment.added');
    // El agregado es el TICKET, no el comentario: así los eventos de un ticket
    // llegan ordenados por un mismo `aggregateId`.
    expect(evento.aggregateId).toBe(TICKET_ID);
    if (result.isOk()) {
      expect(evento.payload).toEqual({
        commentId: result.value.id,
        authorId: ACTOR,
        authorRole: 'AGENT',
        visibility: 'PUBLIC',
      });
      // v2 sumó el rol y v3 la visibilidad (ADR-0028): viajan EN el evento
      // porque lo que importa es cómo era el comentario al escribirse, no lo
      // que haya cuando el consumidor lo procese.
      expect(evento.version).toBe(3);
    }
  });

  describe('notas internas (ADR-0028)', () => {
    it('el equipo deja una nota interna; el evento y la auditoría lo dicen', async () => {
      const { sut, comments, auditLogs, outbox } = buildSut(nuevoTicket());

      const result = await sut.execute({
        tenantId: TENANT,
        actorId: ACTOR,
        actorRole: 'AGENT',
        ticketId: TICKET_ID,
        visibility: 'INTERNAL',
        body: 'Parece el bug de la 4.2.0.',
      });

      expect(result.isOk()).toBe(true);
      expect(comments.comments[0].visibility).toBe('INTERNAL');
      // El SLA y el tiempo real deciden con lo que viaja en el evento.
      expect(outbox.records[0].payload).toMatchObject({
        visibility: 'INTERNAL',
      });
      expect(auditLogs.entries[0].metadata).toMatchObject({
        visibility: 'INTERNAL',
      });
    });

    it('el cliente (VIEWER) no puede escribir una nota interna, y nada se guarda', async () => {
      const { sut, transactions, comments, outbox } = buildSut(nuevoTicket());

      const result = await sut.execute({
        tenantId: TENANT,
        actorId: ACTOR,
        actorRole: 'VIEWER',
        ticketId: TICKET_ID,
        visibility: 'INTERNAL',
        body: 'Quiero ver qué dicen de mí.',
      });

      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.code).toBe('ticketing.internal_note_forbidden');
      }
      expect(comments.comments).toHaveLength(0);
      expect(outbox.records).toHaveLength(0);
      expect(transactions.rollbacks).toBe(1);
    });

    it('el cliente sí puede responder en público', async () => {
      const { sut, comments } = buildSut(nuevoTicket());

      const result = await sut.execute({
        tenantId: TENANT,
        actorId: ACTOR,
        actorRole: 'VIEWER',
        ticketId: TICKET_ID,
        visibility: 'PUBLIC',
        body: 'Tengo la 4.2.0.',
      });

      expect(result.isOk()).toBe(true);
      expect(comments.comments[0].visibility).toBe('PUBLIC');
    });
  });

  it('rechaza un comentario vacío y revierte', async () => {
    const { sut, transactions, comments } = buildSut(nuevoTicket());

    const result = await sut.execute({
      tenantId: TENANT,
      actorId: ACTOR,
      actorRole: 'AGENT',
      ticketId: TICKET_ID,
      visibility: 'PUBLIC',
      body: '   ',
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe('ticketing.empty_comment');
    }
    expect(comments.comments).toHaveLength(0);
    expect(transactions.rollbacks).toBe(1);
  });

  it('no se puede comentar en un ticket cerrado', async () => {
    const { sut, comments } = buildSut(nuevoTicket(true));

    const result = await sut.execute({
      tenantId: TENANT,
      actorId: ACTOR,
      actorRole: 'AGENT',
      ticketId: TICKET_ID,
      visibility: 'PUBLIC',
      body: 'Una cosa más...',
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe('ticketing.ticket_closed');
    }
    expect(comments.comments).toHaveLength(0);
  });

  it('devuelve "no existe" en vez de fallar por clave foránea', async () => {
    // Cargar el ticket antes de insertar es justo lo que convierte un 500 en un 404.
    const { sut } = buildSut(nuevoTicket());

    const result = await sut.execute({
      tenantId: TENANT,
      actorId: ACTOR,
      actorRole: 'AGENT',
      ticketId: TicketId('55555555-5555-5555-5555-555555555555'),
      visibility: 'PUBLIC',
      body: 'Hola',
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe('ticketing.ticket_not_found');
    }
  });

  describe('vuelta automática desde la espera (ADR-0029)', () => {
    const enEspera = () =>
      nuevoTicket(false, ['IN_PROGRESS', 'WAITING_ON_CUSTOMER']);

    it('el comentario del cliente reanuda el reloj y audita el cambio como sistema', async () => {
      const { sut, auditLogs, timers } = buildSut(enEspera());

      const result = await sut.execute({
        tenantId: TENANT,
        actorId: ACTOR,
        actorRole: 'VIEWER',
        ticketId: TICKET_ID,
        visibility: 'PUBLIC',
        body: 'Ahí va la captura que me pidieron.',
      });

      expect(result.isOk()).toBe(true);
      const reloj = timers.stored(RELOJ);
      expect(reloj?.isRunning()).toBe(true);
      expect(reloj?.pausedAt).toBeNull();

      expect(auditLogs.entries.map((e) => e.action)).toEqual([
        'comment.added',
        'ticket.status_changed',
      ]);
      expect(auditLogs.entries[0].actorId).toBe(ACTOR);
      const automatico = auditLogs.entries[1];
      expect(automatico.actorId).toBe(SYSTEM_ACTOR_ID);
      expect(automatico.metadata).toEqual({
        from: 'WAITING_ON_CUSTOMER',
        to: 'IN_PROGRESS',
        automatic: true,
        trigger: 'customer_reply',
        commentId: result.isOk() ? result.value.id : undefined,
      });
    });

    it('una nota interna en espera no reanuda nada ni audita un cambio', async () => {
      const { sut, auditLogs, timers } = buildSut(enEspera());

      await sut.execute({
        tenantId: TENANT,
        actorId: ACTOR,
        actorRole: 'AGENT',
        ticketId: TICKET_ID,
        visibility: 'INTERNAL',
        body: 'Le pedí la captura, espero.',
      });

      expect(timers.stored(RELOJ)?.isPaused()).toBe(true);
      expect(auditLogs.entries.map((e) => e.action)).toEqual(['comment.added']);
    });
  });
});
