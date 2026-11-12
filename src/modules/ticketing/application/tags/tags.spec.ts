import {
  DuplicateTagNameError,
  InvalidTagError,
  TagNotFoundError,
} from '../../domain/errors';
import { TagId } from '../../domain/ids';
import { Tag } from '../../domain/tag/tag.entity';
import { AuditRecorder } from '../audit-recorder';
import {
  ACTOR,
  TENANT,
  fakeAuditLogRepository,
  fakeTags,
  fakeTransactions,
  fixedClock,
  sequentialIds,
} from '../ticketing.test-doubles';
import { CreateTag } from './create-tag.use-case';
import { DeleteTag } from './delete-tag.use-case';
import { ListTags } from './list-tags.use-case';
import { UpdateTag } from './update-tag.use-case';
import { SetTicketTags } from './set-ticket-tags.use-case';
import { Ticket } from '../../domain/entities/ticket.entity';
import {
  TicketClosedError,
  TicketNotFoundError,
  TooManyTagsError,
} from '../../domain/errors';
import { TicketId } from '../../domain/ids';
import { EventRecorder } from '../event-recorder';
import {
  fakeOutbox,
  fakeTicketRepository,
  fakeTicketTags,
} from '../ticketing.test-doubles';

const AHORA = new Date('2026-11-12T10:00:00.000Z');
const DESPUES = new Date('2026-11-12T11:00:00.000Z');
const BUG = TagId('aaaaaaaa-0000-0000-0000-000000000000');
const VIP = TagId('bbbbbbbb-0000-0000-0000-000000000000');
const NO_EXISTE = TagId('cccccccc-0000-0000-0000-000000000000');

const sembrada = (id: TagId, name: string, color = 'gray'): Tag => {
  const r = Tag.create({ id, tenantId: TENANT, name, color, now: AHORA });
  if (r.isErr()) throw new Error(r.error.message);
  return r.value;
};

const montar = () => {
  const tags = fakeTags();
  const auditLogs = fakeAuditLogRepository();
  const transactions = fakeTransactions();
  const audit = new AuditRecorder(sequentialIds(), auditLogs);

  return {
    tags,
    auditLogs,
    create: new CreateTag(
      transactions.manager,
      tags,
      audit,
      sequentialIds(),
      fixedClock(AHORA),
    ),
    update: new UpdateTag(
      transactions.manager,
      tags,
      audit,
      fixedClock(DESPUES),
    ),
    remove: new DeleteTag(
      transactions.manager,
      tags,
      audit,
      fixedClock(DESPUES),
    ),
    list: new ListTags(tags),
  };
};

describe('CreateTag (ADR-0031)', () => {
  it('la crea y la audita', async () => {
    const { create, tags, auditLogs } = montar();

    const r = await create.execute({
      tenantId: TENANT,
      actorId: ACTOR,
      name: ' Facturación ',
      color: 'green',
    });

    expect(r.isOk()).toBe(true);
    if (r.isErr()) return;
    expect(tags.stored(r.value.id)?.name).toBe('Facturación');
    expect(auditLogs.entries[0].action).toBe('tag.created');
    expect(auditLogs.entries[0].entityType).toBe('Tag');
    expect(auditLogs.entries[0].metadata).toEqual({
      name: 'Facturación',
      color: 'green',
    });
  });

  it('un nombre repetido con otras mayúsculas es un duplicado', async () => {
    const { create, tags, auditLogs } = montar();
    tags.seed(sembrada(BUG, 'Bug'));

    const r = await create.execute({
      tenantId: TENANT,
      actorId: ACTOR,
      name: 'BUG',
    });

    expect(r.isErr()).toBe(true);
    if (r.isOk()) return;
    expect(r.error).toBeInstanceOf(DuplicateTagNameError);
    expect(auditLogs.entries).toHaveLength(0);
  });

  it('un color fuera de la paleta no llega al repositorio', async () => {
    const { create } = montar();

    const r = await create.execute({
      tenantId: TENANT,
      actorId: ACTOR,
      name: 'Bug',
      color: 'pink',
    });

    expect(r.isErr()).toBe(true);
    if (r.isOk()) return;
    expect(r.error).toBeInstanceOf(InvalidTagError);
  });
});

describe('UpdateTag (ADR-0031)', () => {
  it('renombra, recolorea y audita el antes y el después', async () => {
    const { update, tags, auditLogs } = montar();
    tags.seed(sembrada(BUG, 'Bug', 'red'));

    const r = await update.execute({
      tenantId: TENANT,
      actorId: ACTOR,
      id: BUG,
      name: 'Error',
      color: 'orange',
    });

    expect(r.isOk()).toBe(true);
    expect(tags.stored(BUG)?.name).toBe('Error');
    expect(tags.stored(BUG)?.color).toBe('orange');
    expect(auditLogs.entries[0].action).toBe('tag.updated');
    expect(auditLogs.entries[0].metadata).toEqual({
      before: { name: 'Bug', color: 'red' },
      after: { name: 'Error', color: 'orange' },
    });
  });

  it('cambiar solo las mayúsculas del propio nombre no es un duplicado', async () => {
    const { update, tags } = montar();
    tags.seed(sembrada(BUG, 'Bug'));

    const r = await update.execute({
      tenantId: TENANT,
      actorId: ACTOR,
      id: BUG,
      name: 'bug',
    });

    expect(r.isOk()).toBe(true);
    expect(tags.stored(BUG)?.name).toBe('bug');
  });

  it('el nombre de OTRA etiqueta es un duplicado', async () => {
    const { update, tags } = montar();
    tags.seed(sembrada(BUG, 'Bug'));
    tags.seed(sembrada(VIP, 'VIP'));

    const r = await update.execute({
      tenantId: TENANT,
      actorId: ACTOR,
      id: VIP,
      name: 'bug',
    });

    expect(r.isErr()).toBe(true);
    if (r.isOk()) return;
    expect(r.error).toBeInstanceOf(DuplicateTagNameError);
    expect(tags.stored(VIP)?.name).toBe('VIP');
  });

  it('sin cambios no audita', async () => {
    const { update, tags, auditLogs } = montar();
    tags.seed(sembrada(BUG, 'Bug', 'red'));

    const r = await update.execute({
      tenantId: TENANT,
      actorId: ACTOR,
      id: BUG,
      name: 'Bug',
      color: 'red',
    });

    expect(r.isOk()).toBe(true);
    expect(auditLogs.entries).toHaveLength(0);
  });

  it('una que no existe es not found', async () => {
    const { update } = montar();

    const r = await update.execute({
      tenantId: TENANT,
      actorId: ACTOR,
      id: NO_EXISTE,
      name: 'X',
    });

    expect(r.isErr()).toBe(true);
    if (r.isOk()) return;
    expect(r.error).toBeInstanceOf(TagNotFoundError);
  });
});

describe('DeleteTag (ADR-0031)', () => {
  it('la borra y deja en la auditoría qué era', async () => {
    const { remove, tags, auditLogs } = montar();
    tags.seed(sembrada(BUG, 'Bug', 'red'));

    const r = await remove.execute({
      tenantId: TENANT,
      actorId: ACTOR,
      id: BUG,
    });

    expect(r.isOk()).toBe(true);
    expect(tags.stored(BUG)).toBeNull();
    expect(auditLogs.entries[0].action).toBe('tag.deleted');
    expect(auditLogs.entries[0].metadata).toEqual({
      name: 'Bug',
      color: 'red',
    });
  });

  it('una que no existe es not found y no se audita', async () => {
    const { remove, auditLogs } = montar();

    const r = await remove.execute({
      tenantId: TENANT,
      actorId: ACTOR,
      id: NO_EXISTE,
    });

    expect(r.isErr()).toBe(true);
    if (r.isOk()) return;
    expect(r.error).toBeInstanceOf(TagNotFoundError);
    expect(auditLogs.entries).toHaveLength(0);
  });
});

describe('ListTags (ADR-0031)', () => {
  it('las devuelve por nombre', async () => {
    const { list, tags } = montar();
    tags.seed(sembrada(VIP, 'vip'));
    tags.seed(sembrada(BUG, 'Bug'));

    const todas = await list.execute({ tenantId: TENANT });

    expect(todas.map((t) => t.name)).toEqual(['Bug', 'vip']);
  });
});

describe('SetTicketTags (ADR-0031)', () => {
  const TICKET = TicketId('44444444-4444-4444-4444-444444444444');
  const OTRO_TICKET = TicketId('55555555-5555-5555-5555-555555555555');

  const nuevoTicket = (id = TICKET, cerrado = false): Ticket => {
    const r = Ticket.open({
      id,
      tenantId: TENANT,
      number: 7,
      subject: 'No anda',
      description: 'Error.',
      priority: 'NORMAL',
      requesterId: ACTOR,
      now: AHORA,
    });
    if (r.isErr()) throw new Error('ticket');
    if (cerrado) {
      r.value.changeStatus('RESOLVED', AHORA);
      r.value.changeStatus('CLOSED', AHORA);
    }
    r.value.pullDomainEvents();
    return r.value;
  };

  const montarSet = (cerrado = false) => {
    const tags = fakeTags();
    tags.seed(sembrada(BUG, 'Bug'));
    tags.seed(sembrada(VIP, 'VIP'));
    const tickets = fakeTicketRepository();
    tickets.seed(nuevoTicket(TICKET, cerrado));
    const ticketTags = fakeTicketTags();
    const auditLogs = fakeAuditLogRepository();
    const outbox = fakeOutbox();
    const ids = sequentialIds();
    const sut = new SetTicketTags(
      fakeTransactions().manager,
      tickets,
      tags,
      ticketTags,
      new AuditRecorder(ids, auditLogs),
      new EventRecorder(ids, outbox),
      fixedClock(DESPUES),
    );
    return { sut, ticketTags, auditLogs, outbox, tickets };
  };

  const poner = (sut: SetTicketTags, tagIds: TagId[], ticketId = TICKET) =>
    sut.execute({ tenantId: TENANT, actorId: ACTOR, ticketId, tagIds });

  it('reemplaza el conjunto, audita con nombres y emite un evento', async () => {
    const { sut, ticketTags, auditLogs, outbox } = montarSet();
    ticketTags.seed(TENANT, TICKET, [VIP]);

    const r = await poner(sut, [BUG]);

    expect(r.isOk()).toBe(true);
    if (r.isErr()) return;
    expect(r.value.map((t) => t.name)).toEqual(['Bug']);
    expect(await ticketTags.tagsOf(TENANT, TICKET)).toEqual([BUG]);
    expect(auditLogs.entries).toHaveLength(1);
    expect(auditLogs.entries[0].action).toBe('ticket.tags_changed');
    expect(auditLogs.entries[0].entityType).toBe('ticket');
    expect(auditLogs.entries[0].metadata).toEqual({
      added: [{ id: BUG, name: 'Bug' }],
      removed: [{ id: VIP, name: 'VIP' }],
    });
    expect(outbox.records.map((e) => e.eventName)).toEqual([
      'ticket.tags_changed',
    ]);
  });

  it('sin cambios no audita ni emite', async () => {
    const { sut, ticketTags, auditLogs, outbox } = montarSet();
    ticketTags.seed(TENANT, TICKET, [BUG]);

    const r = await poner(sut, [BUG, BUG]);

    expect(r.isOk()).toBe(true);
    expect(auditLogs.entries).toHaveLength(0);
    expect(outbox.records).toHaveLength(0);
    expect(ticketTags.replaces).toBe(0);
  });

  it('más de 10 no toca nada', async () => {
    const { sut, ticketTags } = montarSet();
    const once = Array.from({ length: 11 }, (_, i) =>
      TagId(`${String(i).padStart(8, '0')}-0000-0000-0000-000000000000`),
    );

    const r = await poner(sut, once);

    expect(r.isErr()).toBe(true);
    if (r.isOk()) return;
    expect(r.error).toBeInstanceOf(TooManyTagsError);
    expect(ticketTags.replaces).toBe(0);
  });

  it('una etiqueta que no existe (u otra organización) no toca nada', async () => {
    const { sut, ticketTags, auditLogs } = montarSet();

    const r = await poner(sut, [BUG, NO_EXISTE]);

    expect(r.isErr()).toBe(true);
    if (r.isOk()) return;
    expect(r.error).toBeInstanceOf(TagNotFoundError);
    expect(ticketTags.replaces).toBe(0);
    expect(auditLogs.entries).toHaveLength(0);
  });

  it('un ticket que no existe es not found', async () => {
    const { sut } = montarSet();

    const r = await poner(sut, [BUG], OTRO_TICKET);

    expect(r.isErr()).toBe(true);
    if (r.isOk()) return;
    expect(r.error).toBeInstanceOf(TicketNotFoundError);
  });

  it('lee el ticket BLOQUEADO: si otro lo cierra a la vez, no lo reabre', async () => {
    // Revisión final: con una lectura normal, otro agente podía cerrar el
    // ticket entre la lectura y el `save` de éste, que lo reescribía entero
    // con el estado viejo. Bloqueando la fila, esta transacción espera y lee
    // el estado ya cerrado.
    const { sut, tickets } = montarSet();

    await poner(sut, [BUG]);

    expect(tickets.lockedReads).toBe(1);
  });

  it('un ticket cerrado no se re-etiqueta', async () => {
    const { sut, ticketTags } = montarSet(true);

    const r = await poner(sut, [BUG]);

    expect(r.isErr()).toBe(true);
    if (r.isOk()) return;
    expect(r.error).toBeInstanceOf(TicketClosedError);
    expect(ticketTags.replaces).toBe(0);
  });
});
