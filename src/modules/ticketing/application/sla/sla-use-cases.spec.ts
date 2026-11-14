import { Ticket } from '../../domain/entities/ticket.entity';
import { SlaTimerId, TicketId } from '../../domain/ids';
import { DEFAULT_SLA_POLICY } from '../../domain/sla/sla-policy';
import { CALENDAR_24_7 } from '../../domain/sla/sla-calendar';
import { SlaTimer } from '../../domain/sla/sla-timer.entity';
import { SYSTEM_ACTOR_ID } from '../../domain/system-actor';
import { AuditRecorder } from '../audit-recorder';
import { EventRecorder } from '../event-recorder';
import {
  ACTOR,
  TENANT,
  calendars24x7,
  fakeAuditLogRepository,
  fakeBusinessCalendars,
  fakeOutbox,
  fakeProcessedMessages,
  fakeSlaPolicies,
  fakeSlaTimers,
  fakeTicketRepository,
  fakeTransactions,
  fixedClock,
  sequentialIds,
} from '../ticketing.test-doubles';
import { MarkSlaBreached } from './mark-sla-breached.use-case';
import {
  START_SLA_CONSUMER,
  StartSlaTimers,
} from './start-sla-timers.use-case';
import { StopSlaTimer } from './stop-sla-timer.use-case';

const TICKET_ID = TicketId('44444444-4444-4444-4444-444444444444');
const TIMER_ID = SlaTimerId('55555555-5555-5555-5555-555555555555');
const CREADO = new Date('2026-09-09T10:00:00.000Z');
const EVENT_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

const nuevoTicket = (): Ticket => {
  const created = Ticket.open({
    id: TICKET_ID,
    tenantId: TENANT,
    number: 1,
    subject: 'No puedo entrar',
    description: 'Error 500.',
    priority: 'HIGH',
    requesterId: ACTOR,
    now: CREADO,
  });
  if (created.isErr()) throw new Error('el ticket debería haberse creado');
  created.value.pullDomainEvents();
  return created.value;
};

// --------------------------------------------------------------- StartSlaTimers

describe('StartSlaTimers', () => {
  const build = (
    opciones: {
      overrides?: Parameters<typeof fakeSlaPolicies>[0];
      ticket?: Ticket;
      calendars?: ReturnType<typeof fakeBusinessCalendars>;
    } = {},
  ) => {
    const transactions = fakeTransactions();
    const timers = fakeSlaTimers();
    const processed = fakeProcessedMessages();
    const tickets = fakeTicketRepository();
    tickets.seed(opciones.ticket ?? nuevoTicket());
    const sut = new StartSlaTimers(
      transactions.manager,
      fakeSlaPolicies(opciones.overrides),
      timers,
      processed,
      sequentialIds(),
      tickets,
      opciones.calendars ?? calendars24x7(),
    );
    return { sut, transactions, timers, processed };
  };

  const ejecutar = (sut: StartSlaTimers, eventId = EVENT_ID) =>
    sut.execute({
      eventId,
      tenantId: TENANT,
      ticketId: TICKET_ID,
      priority: 'HIGH',
      occurredAt: CREADO,
    });

  it('si el ticket ya espera al cliente, el reloj de resolución nace pausado (ADR-0029)', async () => {
    // La pausa es síncrona pero el arranque es diferido: si el ticket llegó a
    // la espera antes de que el worker procesara `ticket.created`, el
    // coordinador no encontró reloj que pausar. Sin esto, el ticket esperaría
    // con el reloj corriendo hasta incumplir (le pasaba al seed siempre).
    const ticket = nuevoTicket();
    const enEspera = new Date('2026-09-09T10:20:00.000Z');
    ticket.changeStatus('IN_PROGRESS', new Date('2026-09-09T10:10:00.000Z'));
    ticket.changeStatus('WAITING_ON_CUSTOMER', enEspera);
    const { sut, timers } = build({ ticket });

    await ejecutar(sut);

    const resolucion = timers.saved.find((t) => t.kind === 'RESOLUTION');
    const respuesta = timers.saved.find((t) => t.kind === 'RESPONSE');
    expect(resolucion?.isPaused()).toBe(true);
    expect(resolucion?.pausedAt).toEqual(enEspera);
    // Cuenta desde la creación igual que siempre; solo el de resolución pausa.
    expect(resolucion?.startedAt).toEqual(CREADO);
    expect(respuesta?.isRunning()).toBe(true);
  });

  it('con horario laboral los relojes cuentan solo las horas hábiles (ADR-0034)', async () => {
    // Viernes 13/11/2026 17:00 en Argentina, ticket URGENT (15 min / 4 h).
    const viernes17 = new Date('2026-11-13T20:00:00.000Z');
    const { sut, timers } = build({ calendars: fakeBusinessCalendars() });

    await sut.execute({
      eventId: EVENT_ID,
      tenantId: TENANT,
      ticketId: TICKET_ID,
      priority: 'URGENT',
      occurredAt: viernes17,
    });

    const due = (kind: string) =>
      timers.saved.find((t) => t.kind === kind)?.dueAt;
    expect(due('RESPONSE')).toEqual(new Date('2026-11-13T20:15:00.000Z'));
    // 1 h el viernes (17–18) y 3 h el lunes desde las 8: lunes 11:00.
    expect(due('RESOLUTION')).toEqual(new Date('2026-11-16T14:00:00.000Z'));
  });

  it('en 24/7 usa los valores de fábrica de reloj: NORMAL resuelve en 24 h', async () => {
    const { sut, timers } = build();

    await sut.execute({
      eventId: EVENT_ID,
      tenantId: TENANT,
      ticketId: TICKET_ID,
      priority: 'NORMAL',
      occurredAt: CREADO,
    });

    const resolucion = timers.saved.find((t) => t.kind === 'RESOLUTION');
    expect(resolucion?.dueAt).toEqual(
      new Date(CREADO.getTime() + 24 * 3_600_000),
    );
  });

  it('arranca los dos relojes con los objetivos por defecto', async () => {
    const { sut, timers } = build();

    const result = await ejecutar(sut);

    expect(result.isOk()).toBe(true);
    expect(timers.saved).toHaveLength(2);

    const respuesta = timers.saved.find((t) => t.kind === 'RESPONSE');
    const resolucion = timers.saved.find((t) => t.kind === 'RESOLUTION');
    expect(respuesta?.dueAt).toEqual(
      CALENDAR_24_7.dueAt(CREADO, DEFAULT_SLA_POLICY.HIGH.responseMinutes),
    );
    expect(resolucion?.dueAt).toEqual(
      CALENDAR_24_7.dueAt(CREADO, DEFAULT_SLA_POLICY.HIGH.resolutionMinutes),
    );
  });

  it('cuenta desde que se creó el ticket, no desde que corre el job', async () => {
    // Si contara desde ahora, bastaría con que la cola fuera lenta para que
    // ningún SLA incumpliera nunca.
    const { sut, timers } = build();

    await ejecutar(sut);

    expect(
      timers.saved.every((t) => t.startedAt.getTime() === CREADO.getTime()),
    ).toBe(true);
  });

  it('respeta la política que el tenant haya configurado', async () => {
    const { sut, timers } = build({
      overrides: { HIGH: { responseMinutes: 10, resolutionMinutes: 30 } },
    });

    await ejecutar(sut);

    const respuesta = timers.saved.find((t) => t.kind === 'RESPONSE');
    expect(respuesta?.dueAt).toEqual(new Date('2026-09-09T10:10:00.000Z'));
  });

  it('reprocesar el evento no duplica relojes', async () => {
    const { sut, timers } = build();

    await ejecutar(sut);
    const result = await ejecutar(sut);

    if (result.isOk() && result.value.status === 'skipped') {
      expect(result.value.reason).toBe('already_processed');
    } else {
      throw new Error('debería haberse saltado');
    }
    expect(timers.saved).toHaveLength(2);
  });

  it('reclama el mensaje con su propio nombre de consumidor', async () => {
    // Cada consumidor lleva su propia marca: la auto-asignación y el SLA
    // procesan el MISMO `ticket.created` y no deben estorbarse.
    const { sut, processed } = build();

    await ejecutar(sut);

    expect(processed.claims).toEqual([`${START_SLA_CONSUMER}:${EVENT_ID}`]);
  });
});

// ---------------------------------------------------------------- StopSlaTimer

describe('StopSlaTimer', () => {
  const RESPUESTA = new Date('2026-09-09T10:20:00.000Z');

  const build = (opciones: { conReloj?: boolean; pausadoA?: Date } = {}) => {
    const transactions = fakeTransactions();
    const timers = fakeSlaTimers();
    if (opciones.conReloj !== false) {
      const timer = SlaTimer.start({
        id: TIMER_ID,
        tenantId: TENANT,
        ticketId: TICKET_ID,
        kind: 'RESPONSE',
        minutes: 60,
        calendar: CALENDAR_24_7,
        now: CREADO,
      });
      if (opciones.pausadoA !== undefined) timer.pause(opciones.pausadoA);
      timers.seed(timer);
    }
    const sut = new StopSlaTimer(
      transactions.manager,
      timers,
      fakeProcessedMessages(),
      calendars24x7(),
    );
    return { sut, transactions, timers };
  };

  const ejecutar = (sut: StopSlaTimer, eventId = EVENT_ID) =>
    sut.execute({
      eventId,
      tenantId: TENANT,
      ticketId: TICKET_ID,
      kind: 'RESPONSE',
      occurredAt: RESPUESTA,
    });

  it('parar un reloj en pausa lo reanuda con el horario del tenant (ADR-0034)', async () => {
    // Pausado el viernes 13/11 17:30 con vencimiento 19:30: 30 min hábiles.
    const timers = fakeSlaTimers();
    const timer = SlaTimer.start({
      id: TIMER_ID,
      tenantId: TENANT,
      ticketId: TICKET_ID,
      kind: 'RESOLUTION',
      minutes: 120,
      calendar: CALENDAR_24_7,
      now: new Date('2026-11-13T20:30:00.000Z'),
    });
    timer.pause(new Date('2026-11-13T20:30:00.000Z'));
    timers.seed(timer);
    const sut = new StopSlaTimer(
      fakeTransactions().manager,
      timers,
      fakeProcessedMessages(),
      fakeBusinessCalendars(),
    );

    // Se resuelve desde la espera el lunes 16/11 a las 08:10.
    await sut.execute({
      eventId: EVENT_ID,
      tenantId: TENANT,
      ticketId: TICKET_ID,
      kind: 'RESOLUTION',
      occurredAt: new Date('2026-11-16T11:10:00.000Z'),
    });

    // Reanudado a las 08:10 con 30 min hábiles: vence 08:40 (en 24/7, 10:10).
    expect(timers.stored(TIMER_ID)?.dueAt).toEqual(
      new Date('2026-11-16T11:40:00.000Z'),
    );
  });

  it('para el reloj y devuelve el margen que quedaba', async () => {
    const { sut, timers } = build();

    const result = await ejecutar(sut);

    if (result.isOk() && result.value.status === 'stopped') {
      expect(result.value.remainingMinutes).toBe(40);
    } else {
      throw new Error('debería haberse parado');
    }
    expect(timers.saved[0].stoppedAt).toEqual(RESPUESTA);
  });

  it('para con el instante del hecho, no con el del job', async () => {
    const { sut, timers } = build();

    await ejecutar(sut);

    expect(timers.saved[0].stoppedAt).toEqual(RESPUESTA);
  });

  it('sin reloj corriendo se salta, no falla', async () => {
    const { sut, transactions } = build({ conReloj: false });

    const result = await ejecutar(sut);

    if (result.isOk() && result.value.status === 'skipped') {
      expect(result.value.reason).toBe('no_running_timer');
    } else {
      throw new Error('debería haberse saltado');
    }
    // Se salta como ÉXITO: un `err` revertiría la marca de procesado y el job
    // se reintentaría hasta la DLQ sin que nada fuera a cambiar.
    expect(transactions.rollbacks).toBe(0);
  });

  it('reprocesar el mismo evento no vuelve a parar nada', async () => {
    const { sut, timers } = build();

    await ejecutar(sut);
    const result = await ejecutar(sut);

    if (result.isOk() && result.value.status === 'skipped') {
      expect(result.value.reason).toBe('already_processed');
    }
    expect(timers.saved).toHaveLength(1);
  });

  it('para un reloj en pausa y el margen descuenta la pausa (ADR-0029)', async () => {
    // Pausado a las 10:10 con 50 min de margen; se para a las 10:20. Los diez
    // minutos de espera no cuentan: el margen sigue siendo 50.
    const { sut, timers } = build({
      pausadoA: new Date('2026-09-09T10:10:00.000Z'),
    });

    const result = await ejecutar(sut);

    if (result.isOk() && result.value.status === 'stopped') {
      expect(result.value.remainingMinutes).toBe(50);
    } else {
      throw new Error('debería haberse parado');
    }
    const guardado = timers.stored(TIMER_ID);
    expect(guardado?.stoppedAt).toEqual(RESPUESTA);
    expect(guardado?.pausedAt).toBeNull();
  });

  it('si otra escritura gana la carrera, no da el reloj por parado', async () => {
    const { sut, timers } = build();
    timers.loseNextTransition();

    const result = await ejecutar(sut);

    if (result.isOk() && result.value.status === 'skipped') {
      expect(result.value.reason).toBe('no_running_timer');
    } else {
      throw new Error('debería haberse saltado');
    }
    expect(timers.stored(TIMER_ID)?.stoppedAt).toBeNull();
  });
});

// ------------------------------------------------------------- MarkSlaBreached

describe('MarkSlaBreached', () => {
  const AHORA = new Date('2026-09-09T12:00:00.000Z');

  const build = (
    opciones: {
      parado?: boolean;
      vencido?: boolean;
      ticket?: boolean;
      pausado?: boolean;
    } = {},
  ) => {
    const transactions = fakeTransactions();
    const timers = fakeSlaTimers();
    const tickets = fakeTicketRepository();
    if (opciones.ticket !== false) tickets.seed(nuevoTicket());

    const timer = SlaTimer.start({
      id: TIMER_ID,
      tenantId: TENANT,
      ticketId: TICKET_ID,
      kind: 'RESPONSE',
      // Vencido por defecto (60 min desde las 10:00 -> 11:00 < 12:00).
      minutes: opciones.vencido === false ? 10 * 60 : 60,
      calendar: CALENDAR_24_7,
      now: CREADO,
    });
    if (opciones.parado === true)
      timer.stop(new Date('2026-09-09T10:30:00.000Z'), CALENDAR_24_7);
    if (opciones.pausado === true)
      timer.pause(new Date('2026-09-09T10:30:00.000Z'));
    timers.seed(timer);

    const auditLogs = fakeAuditLogRepository();
    const outbox = fakeOutbox();
    const ids = sequentialIds();

    const sut = new MarkSlaBreached(
      transactions.manager,
      timers,
      tickets,
      new AuditRecorder(ids, auditLogs),
      new EventRecorder(ids, outbox),
      fixedClock(AHORA),
    );
    return { sut, transactions, timers, auditLogs, outbox };
  };

  const ejecutar = (sut: MarkSlaBreached) =>
    sut.execute({ tenantId: TENANT, timerId: TIMER_ID });

  it('marca el incumplimiento, lo audita y publica el evento', async () => {
    const { sut, timers, auditLogs, outbox } = build();

    const result = await ejecutar(sut);

    if (result.isOk() && result.value.status === 'breached') {
      expect(result.value.kind).toBe('RESPONSE');
    } else {
      throw new Error('debería haber incumplido');
    }
    expect(timers.saved[0].isBreached()).toBe(true);

    expect(auditLogs.entries[0].action).toBe('sla.breached');
    expect(auditLogs.entries[0].actorId).toBe(SYSTEM_ACTOR_ID);

    // El evento sale del TICKET y lleva su contexto: un escalado necesita saber
    // la prioridad y a quién está asignado, no solo que un reloj venció.
    expect(outbox.records).toHaveLength(1);
    expect(outbox.records[0].eventName).toBe('sla.breached');
    expect(outbox.records[0].payload).toMatchObject({
      kind: 'RESPONSE',
      priority: 'HIGH',
      assigneeId: null,
    });
  });

  it('un reloj parado a tiempo NO incumple aunque el barrido llegue tarde', async () => {
    // Es la recomprobación que hace innecesario bloquear filas en el barrido.
    const { sut, timers, auditLogs, outbox } = build({ parado: true });

    const result = await ejecutar(sut);

    if (result.isOk() && result.value.status === 'skipped') {
      expect(result.value.reason).toBe('not_running');
    } else {
      throw new Error('debería haberse saltado');
    }
    expect(timers.saved).toHaveLength(0);
    expect(auditLogs.entries).toHaveLength(0);
    expect(outbox.records).toHaveLength(0);
  });

  it('un reloj que todavía no ha vencido no se toca', async () => {
    const { sut } = build({ vencido: false });

    const result = await ejecutar(sut);

    if (result.isOk() && result.value.status === 'skipped') {
      expect(result.value.reason).toBe('not_overdue');
    } else {
      throw new Error('debería haberse saltado');
    }
  });

  it('si el ticket ya no existe, no incumple nada', async () => {
    const { sut, timers } = build({ ticket: false });

    const result = await ejecutar(sut);

    if (result.isOk() && result.value.status === 'skipped') {
      expect(result.value.reason).toBe('ticket_not_found');
    } else {
      throw new Error('debería haberse saltado');
    }
    expect(timers.saved).toHaveLength(0);
  });

  it('un reloj en pausa no incumple aunque haya pasado su hora (ADR-0029)', async () => {
    const { sut, timers, auditLogs, outbox } = build({ pausado: true });

    const result = await ejecutar(sut);

    if (result.isOk() && result.value.status === 'skipped') {
      expect(result.value.reason).toBe('paused');
    } else {
      throw new Error('debería haberse saltado');
    }
    expect(timers.saved).toHaveLength(0);
    expect(auditLogs.entries).toHaveLength(0);
    expect(outbox.records).toHaveLength(0);
  });

  it('si una pausa gana la carrera, ni audita ni publica', async () => {
    // El agente pausó entre la lectura y la escritura del barrido: el UPDATE
    // condicionado no toca la fila y el incumplimiento no existió.
    const { sut, timers, auditLogs, outbox } = build();
    timers.loseNextTransition();

    const result = await ejecutar(sut);

    if (result.isOk() && result.value.status === 'skipped') {
      expect(result.value.reason).toBe('not_running');
    } else {
      throw new Error('debería haberse saltado');
    }
    expect(timers.stored(TIMER_ID)?.isBreached()).toBe(false);
    expect(auditLogs.entries).toHaveLength(0);
    expect(outbox.records).toHaveLength(0);
  });
});
