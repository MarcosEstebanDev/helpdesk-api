import { Ticket } from '../domain/entities/ticket.entity';
import { TicketId } from '../domain/ids';
import { AuditRecorder } from './audit-recorder';
import { ChangeTicketStatus } from './change-ticket-status.use-case';
import { EventRecorder } from './event-recorder';
import {
  ACTOR,
  AHORA,
  TENANT,
  fakeAuditLogRepository,
  fakeOutbox,
  fakeTicketRepository,
  fakeTransactions,
  fixedClock,
  sequentialIds,
} from './ticketing.test-doubles';

const TICKET_ID = TicketId('44444444-4444-4444-4444-444444444444');
const ANTES = new Date('2026-09-09T08:00:00Z');

const ticketEn = (...transiciones: Parameters<Ticket['changeStatus']>[0][]) => {
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

  for (const destino of transiciones) {
    created.value.changeStatus(destino, ANTES);
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
  const auditLogs = fakeAuditLogRepository();
  const ids = sequentialIds();
  const audit = new AuditRecorder(ids, auditLogs);
  const outbox = fakeOutbox();

  const sut = new ChangeTicketStatus(
    transactions.manager,
    tickets,
    audit,
    new EventRecorder(ids, outbox),
    fixedClock(),
  );

  return { sut, transactions, tickets, auditLogs, outbox };
};

describe('ChangeTicketStatus', () => {
  it('aplica una transición legal y la audita con el origen y el destino', async () => {
    const { sut, tickets, auditLogs } = buildSut(ticketEn());

    const result = await sut.execute({
      tenantId: TENANT,
      actorId: ACTOR,
      ticketId: TICKET_ID,
      status: 'IN_PROGRESS',
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) expect(result.value.status).toBe('IN_PROGRESS');
    expect(tickets.saved).toHaveLength(1);

    expect(auditLogs.entries).toHaveLength(1);
    expect(auditLogs.entries[0].action).toBe('ticket.status_changed');
    // El "de dónde a dónde" es lo único que hace útil una entrada de auditoría
    // de cambio de estado; sin ello el historial no reconstruye nada.
    expect(auditLogs.entries[0].metadata).toEqual({
      from: 'OPEN',
      to: 'IN_PROGRESS',
    });
    expect(auditLogs.entries[0].occurredAt).toBe(AHORA);
  });

  it('publica ticket.status_changed con el estado anterior y el nuevo', async () => {
    const { sut, outbox } = buildSut(ticketEn());

    await sut.execute({
      tenantId: TENANT,
      actorId: ACTOR,
      ticketId: TICKET_ID,
      status: 'IN_PROGRESS',
    });

    expect(outbox.records).toHaveLength(1);
    expect(outbox.records[0].eventName).toBe('ticket.status_changed');
    expect(outbox.records[0].payload).toEqual({
      from: 'OPEN',
      to: 'IN_PROGRESS',
      assigneeId: null,
    });
  });

  it('una transición rechazada no deja nada en el outbox', async () => {
    const { sut, outbox } = buildSut(ticketEn());

    await sut.execute({
      tenantId: TENANT,
      actorId: ACTOR,
      ticketId: TICKET_ID,
      status: 'CLOSED',
    });

    expect(outbox.records).toHaveLength(0);
  });

  it('rechaza una transición ilegal y revierte, sin guardar ni auditar', async () => {
    const { sut, transactions, tickets, auditLogs } = buildSut(ticketEn());

    const result = await sut.execute({
      tenantId: TENANT,
      actorId: ACTOR,
      ticketId: TICKET_ID,
      status: 'CLOSED', // OPEN -> CLOSED no está permitido (ADR-0015)
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe('ticketing.invalid_transition');
    }
    expect(tickets.saved).toHaveLength(0);
    expect(auditLogs.entries).toHaveLength(0);
    expect(transactions.rollbacks).toBe(1);
  });

  it('pedir el estado actual no genera ruido en el historial', async () => {
    const { sut, tickets, auditLogs } = buildSut(ticketEn());

    const result = await sut.execute({
      tenantId: TENANT,
      actorId: ACTOR,
      ticketId: TICKET_ID,
      status: 'OPEN',
    });

    expect(result.isOk()).toBe(true);
    // Un reintento del cliente no debe llenar la auditoría de entradas que no
    // cuentan nada, ni tocar `updated_at`.
    expect(tickets.saved).toHaveLength(0);
    expect(auditLogs.entries).toHaveLength(0);
  });

  it('devuelve "no existe" si el ticket no está en este tenant', async () => {
    const { sut, transactions } = buildSut(ticketEn());

    const result = await sut.execute({
      tenantId: TENANT,
      actorId: ACTOR,
      ticketId: TicketId('55555555-5555-5555-5555-555555555555'),
      status: 'IN_PROGRESS',
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe('ticketing.ticket_not_found');
    }
    expect(transactions.rollbacks).toBe(1);
  });

  it('un ticket cerrado ya no se mueve', async () => {
    const { sut } = buildSut(ticketEn('RESOLVED', 'CLOSED'));

    const result = await sut.execute({
      tenantId: TENANT,
      actorId: ACTOR,
      ticketId: TICKET_ID,
      status: 'OPEN',
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe('ticketing.invalid_transition');
    }
  });
});
