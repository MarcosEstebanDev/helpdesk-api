import { Ticket } from '../../domain/entities/ticket.entity';
import {
  TriageRejectedError,
  TriageUnavailableError,
} from '../../domain/errors';
import { TicketId } from '../../domain/ids';
import { SYSTEM_ACTOR_ID } from '../../domain/system-actor';
import { TicketTriage } from '../../domain/triage/ticket-triage.entity';
import { AuditRecorder } from '../audit-recorder';
import { EventRecorder } from '../event-recorder';
import {
  ACTOR,
  AHORA,
  CLASIFICACION_EJEMPLO,
  OTRO_TENANT,
  TENANT,
  fakeAuditLogRepository,
  fakeClassifier,
  fakeOutbox,
  fakeProcessedMessages,
  fakeTicketRepository,
  fakeTicketTriages,
  fakeTransactions,
  fixedClock,
  sequentialIds,
} from '../ticketing.test-doubles';
import { TRIAGE_CONSUMER, TriageTicket } from './triage-ticket.use-case';

const TICKET_ID = TicketId('44444444-4444-4444-4444-444444444444');
const EVENT_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

const nuevoTicket = (): Ticket => {
  const created = Ticket.open({
    id: TICKET_ID,
    tenantId: TENANT,
    number: 7,
    subject: 'Me cobraron dos veces',
    description: 'La factura de octubre salió duplicada.',
    priority: 'NORMAL',
    requesterId: ACTOR,
    now: AHORA,
  });
  if (created.isErr()) throw new Error('el ticket debería haberse creado');
  created.value.pullDomainEvents();
  return created.value;
};

const buildSut = (
  opciones: {
    conTicket?: boolean;
    clasificador?: ReturnType<typeof fakeClassifier>;
    yaProcesados?: readonly string[];
  } = {},
) => {
  const transactions = fakeTransactions();
  const tickets = fakeTicketRepository();
  if (opciones.conTicket !== false) tickets.seed(nuevoTicket());
  const triages = fakeTicketTriages();
  const classifier = opciones.clasificador ?? fakeClassifier();
  const processed = fakeProcessedMessages(opciones.yaProcesados);
  const auditLogs = fakeAuditLogRepository();
  const outbox = fakeOutbox();
  const ids = sequentialIds();

  const sut = new TriageTicket(
    transactions.manager,
    tickets,
    triages,
    classifier,
    processed,
    new AuditRecorder(ids, auditLogs),
    new EventRecorder(ids, outbox),
    fixedClock(),
  );
  return { sut, transactions, tickets, triages, classifier, auditLogs, outbox };
};

const input = { eventId: EVENT_ID, tenantId: TENANT, ticketId: TICKET_ID };

describe('TriageTicket', () => {
  it('manda SOLO el texto del ticket al clasificador', async () => {
    const { sut, classifier } = buildSut();

    await sut.execute(input);

    // Ni ids ni tenant: el servicio de IA no puede relacionar el texto con nadie.
    expect(classifier.calls).toEqual([
      {
        subject: 'Me cobraron dos veces',
        description: 'La factura de octubre salió duplicada.',
      },
    ]);
  });

  it('guarda la sugerencia, la audita como sistema y emite ticket.triaged', async () => {
    const { sut, triages, auditLogs, outbox } = buildSut();

    const result = await sut.execute(input);

    expect(result.isOk() && result.value).toEqual({
      status: 'triaged',
      category: 'billing',
      suggestedPriority: 'HIGH',
    });
    expect(triages.saved).toHaveLength(1);
    expect(triages.saved[0]?.provenance.promptVersion).toBe('triage-v1');
    expect(auditLogs.entries[0]?.action).toBe('ticket.triaged');
    expect(auditLogs.entries[0]?.actorId).toBe(SYSTEM_ACTOR_ID);
    expect(outbox.records.map((r) => r.eventName)).toEqual(['ticket.triaged']);
    expect(outbox.records[0]?.payload).toMatchObject({
      category: 'billing',
      suggestedPriority: 'HIGH',
      model: 'fake-model',
    });
  });

  it('NO cambia la prioridad del ticket: la IA sugiere, no decide', async () => {
    const { sut, tickets } = buildSut();

    await sut.execute(input);

    // El ticket se LEE para clasificarlo, pero nunca se guarda: su prioridad
    // (y con ella los relojes de SLA) solo la cambia una persona.
    expect(tickets.saved).toHaveLength(0);
    const ticket = await tickets.findById(TENANT, TICKET_ID);
    expect(ticket?.priority).toBe('NORMAL');
  });

  it('no paga una llamada al modelo si el ticket ya tenía triage', async () => {
    const { sut, triages, classifier } = buildSut();
    await triages.save(
      TicketTriage.rehydrate({
        ticketId: TICKET_ID,
        tenantId: TENANT,
        ...CLASIFICACION_EJEMPLO,
        triagedAt: AHORA,
      }),
    );

    const result = await sut.execute(input);

    expect(result.isOk() && result.value).toEqual({
      status: 'skipped',
      reason: 'already_triaged',
    });
    expect(classifier.calls).toHaveLength(0);
  });

  it('salta si el ticket no existe (o es de otro tenant)', async () => {
    const { sut, classifier } = buildSut();

    const result = await sut.execute({ ...input, tenantId: OTRO_TENANT });

    expect(result.isOk() && result.value).toEqual({
      status: 'skipped',
      reason: 'ticket_not_found',
    });
    expect(classifier.calls).toHaveLength(0);
  });

  it('es idempotente por evento', async () => {
    const { sut, triages, outbox } = buildSut({
      yaProcesados: [`${TRIAGE_CONSUMER}:${EVENT_ID}`],
    });

    const result = await sut.execute(input);

    expect(result.isOk() && result.value).toEqual({
      status: 'skipped',
      reason: 'already_processed',
    });
    expect(triages.saved).toHaveLength(0);
    expect(outbox.records).toHaveLength(0);
  });

  it.each([
    ['transitorio', new TriageUnavailableError('timeout')],
    ['permanente', new TriageRejectedError('respuesta inválida')],
  ])(
    'un fallo %s del clasificador no abre transacción ni guarda nada',
    async (_tipo, error) => {
      const { sut, transactions, triages } = buildSut({
        clasificador: fakeClassifier(error),
      });

      const result = await sut.execute(input);

      expect(result.isErr() && result.error).toBe(error);
      expect(transactions.commits + transactions.rollbacks).toBe(0);
      expect(triages.saved).toHaveLength(0);
    },
  );
});
