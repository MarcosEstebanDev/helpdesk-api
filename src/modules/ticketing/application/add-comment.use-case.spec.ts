import { Ticket } from '../domain/entities/ticket.entity';
import { TicketId } from '../domain/ids';
import { AddComment } from './add-comment.use-case';
import { AuditRecorder } from './audit-recorder';
import { EventRecorder } from './event-recorder';
import {
  ACTOR,
  AHORA,
  TENANT,
  fakeAuditLogRepository,
  fakeCommentRepository,
  fakeOutbox,
  fakeTicketRepository,
  fakeTransactions,
  fixedClock,
  sequentialIds,
} from './ticketing.test-doubles';

const TICKET_ID = TicketId('44444444-4444-4444-4444-444444444444');
const ANTES = new Date('2026-09-09T08:00:00Z');

const nuevoTicket = (cerrado = false): Ticket => {
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

  const sut = new AddComment(
    transactions.manager,
    tickets,
    comments,
    audit,
    new EventRecorder(ids, outbox),
    ids,
    fixedClock(),
  );

  return { sut, transactions, comments, auditLogs, outbox };
};

describe('AddComment', () => {
  it('guarda el comentario y lo audita en la misma transacción', async () => {
    const { sut, transactions, comments, auditLogs } = buildSut(nuevoTicket());

    const result = await sut.execute({
      tenantId: TENANT,
      actorId: ACTOR,
      actorRole: 'AGENT',
      ticketId: TICKET_ID,
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
      });
      // v2: el rol viaja EN el evento porque lo que importa es cuál tenía al
      // comentar, no el que tenga cuando el consumidor lo procese.
      expect(evento.version).toBe(2);
    }
  });

  it('rechaza un comentario vacío y revierte', async () => {
    const { sut, transactions, comments } = buildSut(nuevoTicket());

    const result = await sut.execute({
      tenantId: TENANT,
      actorId: ACTOR,
      actorRole: 'AGENT',
      ticketId: TICKET_ID,
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
      body: 'Hola',
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe('ticketing.ticket_not_found');
    }
  });
});
