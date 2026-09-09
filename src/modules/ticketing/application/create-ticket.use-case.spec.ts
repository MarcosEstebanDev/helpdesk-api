import { AuditRecorder } from './audit-recorder';
import { CreateTicket } from './create-ticket.use-case';
import {
  ACTOR,
  AHORA,
  TENANT,
  fakeAuditLogRepository,
  fakeNumberGenerator,
  fakeTicketRepository,
  fakeTransactions,
  fixedClock,
  sequentialIds,
} from './ticketing.test-doubles';

const buildSut = () => {
  const transactions = fakeTransactions();
  const tickets = fakeTicketRepository();
  const numbers = fakeNumberGenerator();
  const auditLogs = fakeAuditLogRepository();
  const ids = sequentialIds();
  const audit = new AuditRecorder(ids, auditLogs);

  const sut = new CreateTicket(
    transactions.manager,
    tickets,
    numbers,
    audit,
    ids,
    fixedClock(),
  );

  return { sut, transactions, tickets, numbers, auditLogs };
};

const entrada = (overrides: Partial<{ subject: string }> = {}) => ({
  tenantId: TENANT,
  actorId: ACTOR,
  subject: overrides.subject ?? 'No puedo entrar',
  description: 'Me da un error 500.',
  priority: 'NORMAL' as const,
});

describe('CreateTicket', () => {
  it('crea el ticket con el número reservado y lo deja OPEN', async () => {
    const { sut, tickets } = buildSut();

    const result = await sut.execute(entrada());

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.number).toBe(1);
      expect(result.value.status).toBe('OPEN');
      expect(result.value.requesterId).toBe(ACTOR);
      expect(result.value.createdAt).toBe(AHORA);
    }
    expect(tickets.saved).toHaveLength(1);
  });

  it('escribe la auditoría en la MISMA transacción que el ticket', async () => {
    const { sut, transactions, auditLogs } = buildSut();

    await sut.execute(entrada());

    // Una sola transacción para las dos escrituras: eso es el ADR-0016.
    expect(transactions.commits).toBe(1);
    expect(transactions.rollbacks).toBe(0);
    expect(auditLogs.entries).toHaveLength(1);

    const entrada0 = auditLogs.entries[0];
    expect(entrada0.action).toBe('ticket.created');
    expect(entrada0.entityType).toBe('ticket');
    expect(entrada0.actorId).toBe(ACTOR);
    expect(entrada0.metadata).toEqual({ number: 1, priority: 'NORMAL' });
  });

  it('el actor autenticado es el solicitante del ticket', async () => {
    // El requester NO se acepta del cuerpo de la petición: sale del JWT. Si
    // alguna vez se añadiera al DTO, este test lo delataría.
    const { sut } = buildSut();

    const result = await sut.execute(entrada());

    if (result.isOk()) expect(result.value.requesterId).toBe(ACTOR);
  });

  it('numera correlativamente dentro del tenant', async () => {
    const { sut } = buildSut();

    const primero = await sut.execute(entrada());
    const segundo = await sut.execute(entrada());

    if (primero.isOk()) expect(primero.value.number).toBe(1);
    if (segundo.isOk()) expect(segundo.value.number).toBe(2);
  });

  describe('cuando la validación del dominio falla', () => {
    it('revierte la transacción para no dejar el número consumido', async () => {
      const { sut, transactions, numbers } = buildSut();

      const result = await sut.execute(entrada({ subject: '   ' }));

      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.code).toBe('ticketing.invalid_subject');
      }
      // El número llegó a pedirse (va dentro de la transacción)...
      expect(numbers.calls).toBe(1);
      // ...pero la transacción se revierte, así que en la base de datos real el
      // contador vuelve atrás y la numeración no queda con un hueco (ADR-0017).
      expect(transactions.rollbacks).toBe(1);
      expect(transactions.commits).toBe(0);
    });

    it('no guarda ni el ticket ni su auditoría', async () => {
      const { sut, tickets, auditLogs } = buildSut();

      await sut.execute(entrada({ subject: '' }));

      expect(tickets.saved).toHaveLength(0);
      expect(auditLogs.entries).toHaveLength(0);
    });
  });
});
