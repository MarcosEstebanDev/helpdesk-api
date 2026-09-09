import { Ticket } from '../domain/entities/ticket.entity';
import { TicketId, UserId } from '../domain/ids';
import { SYSTEM_ACTOR_ID } from '../domain/system-actor';
import { AuditRecorder } from './audit-recorder';
import {
  AUTO_ASSIGN_CONSUMER,
  AutoAssignTicket,
} from './auto-assign-ticket.use-case';
import { EventRecorder } from './event-recorder';
import {
  ACTOR,
  TENANT,
  fakeAuditLogRepository,
  fakeMemberDirectory,
  fakeOutbox,
  fakeProcessedMessages,
  fakeTicketRepository,
  fakeTransactions,
  fixedClock,
  sequentialIds,
} from './ticketing.test-doubles';

const TICKET_ID = TicketId('44444444-4444-4444-4444-444444444444');
const ANTES = new Date('2026-09-09T08:00:00Z');
const EVENT_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

// Ordenados: `agentsOf` promete orden estable, y el reparto depende de él.
const AGENTE_A = UserId('a0000000-0000-0000-0000-000000000000');
const AGENTE_B = UserId('b0000000-0000-0000-0000-000000000000');
const AGENTE_C = UserId('c0000000-0000-0000-0000-000000000000');

const nuevoTicket = (opciones: { numero?: number; cerrado?: boolean } = {}) => {
  const created = Ticket.open({
    id: TICKET_ID,
    tenantId: TENANT,
    number: opciones.numero ?? 1,
    subject: 'No puedo entrar',
    description: 'Error 500.',
    priority: 'NORMAL',
    requesterId: ACTOR,
    now: ANTES,
  });
  if (created.isErr()) throw new Error('el ticket debería haberse creado');

  if (opciones.cerrado === true) {
    created.value.changeStatus('RESOLVED', ANTES);
    created.value.changeStatus('CLOSED', ANTES);
  }
  // Un ticket que viene del repositorio se rehidrata: sin eventos pendientes.
  created.value.pullDomainEvents();
  return created.value;
};

const buildSut = (
  opciones: {
    semilla?: Ticket | null;
    agentes?: readonly UserId[];
    yaProcesados?: readonly string[];
  } = {},
) => {
  const transactions = fakeTransactions();
  const tickets = fakeTicketRepository();
  const semilla =
    opciones.semilla === undefined ? nuevoTicket() : opciones.semilla;
  if (semilla !== null) tickets.seed(semilla);

  const auditLogs = fakeAuditLogRepository();
  const ids = sequentialIds();
  const outbox = fakeOutbox();
  const processed = fakeProcessedMessages(opciones.yaProcesados);
  const agentes = opciones.agentes ?? [AGENTE_A, AGENTE_B, AGENTE_C];

  const sut = new AutoAssignTicket(
    transactions.manager,
    tickets,
    fakeMemberDirectory(agentes, agentes),
    processed,
    new AuditRecorder(ids, auditLogs),
    new EventRecorder(ids, outbox),
    fixedClock(),
  );

  return { sut, transactions, tickets, auditLogs, outbox, processed };
};

const ejecutar = (
  sut: AutoAssignTicket,
  overrides: { ticketNumber?: number; eventId?: string } = {},
) =>
  sut.execute({
    eventId: overrides.eventId ?? EVENT_ID,
    tenantId: TENANT,
    ticketId: TICKET_ID,
    ticketNumber: overrides.ticketNumber ?? 1,
  });

describe('AutoAssignTicket', () => {
  describe('reparto round-robin', () => {
    it('reparte por el número del ticket, en rotación', async () => {
      // #1 -> primer agente, #2 -> segundo, #3 -> tercero, #4 -> vuelta a empezar.
      const esperado = [AGENTE_A, AGENTE_B, AGENTE_C, AGENTE_A, AGENTE_B];

      for (const [indice, agente] of esperado.entries()) {
        const numero = indice + 1;
        const { sut } = buildSut({ semilla: nuevoTicket({ numero }) });

        const result = await ejecutar(sut, {
          ticketNumber: numero,
          eventId: `evento-${numero}`,
        });

        expect(result.isOk()).toBe(true);
        if (result.isOk() && result.value.status === 'assigned') {
          expect(result.value.assigneeId).toBe(agente);
        } else {
          throw new Error(`el ticket #${numero} debería haberse asignado`);
        }
      }
    });

    it('es determinista: el mismo ticket da siempre el mismo agente', async () => {
      // Esta es la propiedad que hace que la idempotencia no dependa SOLO de la
      // tabla de procesados: aunque el evento se reprocesara, no habría dos
      // repartos distintos.
      const primero = buildSut({ semilla: nuevoTicket({ numero: 7 }) });
      const segundo = buildSut({ semilla: nuevoTicket({ numero: 7 }) });

      const a = await ejecutar(primero.sut, { ticketNumber: 7 });
      const b = await ejecutar(segundo.sut, { ticketNumber: 7 });

      if (
        a.isOk() &&
        b.isOk() &&
        a.value.status === 'assigned' &&
        b.value.status === 'assigned'
      ) {
        expect(a.value.assigneeId).toBe(b.value.assigneeId);
      } else {
        throw new Error('ambos deberían haberse asignado');
      }
    });

    it('con un solo agente, todo va a él', async () => {
      const { sut } = buildSut({
        semilla: nuevoTicket({ numero: 42 }),
        agentes: [AGENTE_B],
      });

      const result = await ejecutar(sut, { ticketNumber: 42 });

      if (result.isOk() && result.value.status === 'assigned') {
        expect(result.value.assigneeId).toBe(AGENTE_B);
      } else {
        throw new Error('debería haberse asignado');
      }
    });
  });

  describe('idempotencia', () => {
    it('reclama el mensaje antes de hacer nada', async () => {
      const { sut, processed } = buildSut();

      await ejecutar(sut);

      expect(processed.claims).toEqual([`${AUTO_ASSIGN_CONSUMER}:${EVENT_ID}`]);
    });

    it('un evento ya procesado no vuelve a asignar', async () => {
      const { sut, tickets, auditLogs, outbox } = buildSut({
        yaProcesados: [`${AUTO_ASSIGN_CONSUMER}:${EVENT_ID}`],
      });

      const result = await ejecutar(sut);

      expect(result.isOk()).toBe(true);
      if (result.isOk() && result.value.status === 'skipped') {
        expect(result.value.reason).toBe('already_processed');
      }
      // Ni guarda, ni audita, ni publica: la entrega at-least-once no se nota.
      expect(tickets.saved).toHaveLength(0);
      expect(auditLogs.entries).toHaveLength(0);
      expect(outbox.records).toHaveLength(0);
    });
  });

  describe('situaciones que NO son un fallo', () => {
    it('un ticket que ya no existe se salta sin error', async () => {
      // Devolverlo como error revertiría la marca de procesado y el job se
      // reintentaría hasta la DLQ sin que nada fuera a cambiar.
      const { sut, transactions } = buildSut({ semilla: null });

      const result = await ejecutar(sut);

      expect(result.isOk()).toBe(true);
      if (result.isOk() && result.value.status === 'skipped') {
        expect(result.value.reason).toBe('ticket_not_found');
      }
      expect(transactions.commits).toBe(1);
      expect(transactions.rollbacks).toBe(0);
    });

    it('respeta una asignación manual previa', async () => {
      const ticket = nuevoTicket();
      ticket.assignTo(AGENTE_C, ANTES);
      ticket.pullDomainEvents();
      const { sut, tickets } = buildSut({ semilla: ticket });

      const result = await ejecutar(sut);

      if (result.isOk() && result.value.status === 'skipped') {
        expect(result.value.reason).toBe('already_assigned');
      } else {
        throw new Error('debería haberse saltado');
      }
      expect(tickets.saved).toHaveLength(0);
    });

    it('sin agentes en la organización, no hay a quién asignar', async () => {
      const { sut, transactions } = buildSut({ agentes: [] });

      const result = await ejecutar(sut);

      if (result.isOk() && result.value.status === 'skipped') {
        expect(result.value.reason).toBe('no_agents');
      } else {
        throw new Error('debería haberse saltado');
      }
      expect(transactions.commits).toBe(1);
    });

    it('un ticket cerrado no se asigna', async () => {
      const { sut } = buildSut({ semilla: nuevoTicket({ cerrado: true }) });

      const result = await ejecutar(sut);

      if (result.isOk() && result.value.status === 'skipped') {
        expect(result.value.reason).toBe('not_assignable');
      } else {
        throw new Error('debería haberse saltado');
      }
    });
  });

  describe('rastro de lo que hace', () => {
    it('audita la asignación como automática y a nombre del sistema', async () => {
      const { sut, auditLogs } = buildSut();

      await ejecutar(sut);

      expect(auditLogs.entries).toHaveLength(1);
      expect(auditLogs.entries[0].action).toBe('ticket.assigned');
      // No lo hizo una persona: el actor es el sistema, y el metadato lo dice.
      expect(auditLogs.entries[0].actorId).toBe(SYSTEM_ACTOR_ID);
      expect(auditLogs.entries[0].metadata).toEqual({
        assigneeId: AGENTE_A,
        automatic: true,
      });
    });

    it('publica el ticket.assigned resultante', async () => {
      // Un job puede provocar nuevos eventos, y salen por el mismo outbox.
      const { sut, outbox } = buildSut();

      await ejecutar(sut);

      expect(outbox.records).toHaveLength(1);
      expect(outbox.records[0].eventName).toBe('ticket.assigned');
    });
  });
});
