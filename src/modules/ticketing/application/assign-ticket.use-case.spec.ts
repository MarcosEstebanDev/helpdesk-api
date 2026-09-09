import { Ticket } from '../domain/entities/ticket.entity';
import { TicketId } from '../domain/ids';
import { AssignTicket } from './assign-ticket.use-case';
import { AuditRecorder } from './audit-recorder';
import {
  ACTOR,
  AGENTE,
  AJENO,
  TENANT,
  fakeAuditLogRepository,
  fakeMemberDirectory,
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
  return created.value;
};

const buildSut = (semilla: Ticket) => {
  const transactions = fakeTransactions();
  const tickets = fakeTicketRepository();
  tickets.seed(semilla);
  const auditLogs = fakeAuditLogRepository();
  const audit = new AuditRecorder(sequentialIds(), auditLogs);

  const sut = new AssignTicket(
    transactions.manager,
    tickets,
    // Solo AGENTE pertenece a la organización; AJENO no.
    fakeMemberDirectory([AGENTE]),
    audit,
    fixedClock(),
  );

  return { sut, transactions, tickets, auditLogs };
};

describe('AssignTicket', () => {
  it('asigna a un miembro y lo audita', async () => {
    const { sut, auditLogs } = buildSut(nuevoTicket());

    const result = await sut.execute({
      tenantId: TENANT,
      actorId: ACTOR,
      ticketId: TICKET_ID,
      assigneeId: AGENTE,
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.assigneeId).toBe(AGENTE);
      // Asignar no arranca el trabajo: el estado no se toca.
      expect(result.value.status).toBe('OPEN');
    }
    expect(auditLogs.entries[0].action).toBe('ticket.assigned');
    expect(auditLogs.entries[0].metadata).toEqual({ assigneeId: AGENTE });
  });

  it('desasigna cuando el destinatario es null y lo registra como tal', async () => {
    const ticket = nuevoTicket();
    ticket.assignTo(AGENTE, ANTES);
    const { sut, auditLogs } = buildSut(ticket);

    const result = await sut.execute({
      tenantId: TENANT,
      actorId: ACTOR,
      ticketId: TICKET_ID,
      assigneeId: null,
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) expect(result.value.assigneeId).toBeNull();
    expect(auditLogs.entries[0].action).toBe('ticket.unassigned');
  });

  it('no permite asignar a alguien que no pertenece a la organización', async () => {
    // Sin esta comprobación el error llegaría como violación de clave foránea
    // (un 500) en vez de como un 404 con sentido.
    const { sut, tickets, transactions } = buildSut(nuevoTicket());

    const result = await sut.execute({
      tenantId: TENANT,
      actorId: ACTOR,
      ticketId: TICKET_ID,
      assigneeId: AJENO,
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe('ticketing.assignee_not_found');
    }
    expect(tickets.saved).toHaveLength(0);
    expect(transactions.rollbacks).toBe(1);
  });

  it('no se comprueba la pertenencia al desasignar', async () => {
    // Desasignar no nombra a nadie, así que no hay nada que validar.
    const { sut } = buildSut(nuevoTicket());

    const result = await sut.execute({
      tenantId: TENANT,
      actorId: ACTOR,
      ticketId: TICKET_ID,
      assigneeId: null,
    });

    expect(result.isOk()).toBe(true);
  });

  it('un ticket cerrado no se puede asignar', async () => {
    const { sut, auditLogs } = buildSut(nuevoTicket(true));

    const result = await sut.execute({
      tenantId: TENANT,
      actorId: ACTOR,
      ticketId: TICKET_ID,
      assigneeId: AGENTE,
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe('ticketing.ticket_closed');
    }
    expect(auditLogs.entries).toHaveLength(0);
  });

  it('devuelve "no existe" para un ticket de otro tenant', async () => {
    const { sut } = buildSut(nuevoTicket());

    const result = await sut.execute({
      tenantId: TENANT,
      actorId: ACTOR,
      ticketId: TicketId('55555555-5555-5555-5555-555555555555'),
      assigneeId: AGENTE,
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe('ticketing.ticket_not_found');
    }
  });
});
