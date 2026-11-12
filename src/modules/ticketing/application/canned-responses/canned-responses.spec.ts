import { CannedResponse } from '../../domain/canned-response/canned-response.entity';
import {
  CannedResponseNotFoundError,
  DuplicateCannedResponseTitleError,
  InvalidCannedResponseError,
} from '../../domain/errors';
import { CannedResponseId } from '../../domain/ids';
import { AuditRecorder } from '../audit-recorder';
import {
  ACTOR,
  TENANT,
  fakeAuditLogRepository,
  fakeCannedResponses,
  fakeTransactions,
  fixedClock,
  sequentialIds,
} from '../ticketing.test-doubles';
import { CreateCannedResponse } from './create-canned-response.use-case';
import { DeleteCannedResponse } from './delete-canned-response.use-case';
import { ListCannedResponses } from './list-canned-responses.use-case';
import { UpdateCannedResponse } from './update-canned-response.use-case';

const AHORA = new Date('2026-11-12T10:00:00.000Z');
const EXISTENTE = CannedResponseId('77777777-7777-7777-7777-777777777777');
const OTRA = CannedResponseId('88888888-8888-8888-8888-888888888888');
const NO_EXISTE = CannedResponseId('99999999-9999-9999-9999-999999999999');
const DESPUES = new Date('2026-11-12T11:00:00.000Z');

const sembrada = (title: string, id = EXISTENTE): CannedResponse => {
  const r = CannedResponse.create({
    id,
    tenantId: TENANT,
    title,
    body: 'Hola',
    createdBy: ACTOR,
    now: AHORA,
  });
  if (r.isErr()) throw r.error;
  return r.value;
};

const montar = () => {
  const repo = fakeCannedResponses();
  const auditLogs = fakeAuditLogRepository();
  const transactions = fakeTransactions();
  const audit = new AuditRecorder(sequentialIds(), auditLogs);
  const clock = fixedClock(AHORA);

  return {
    repo,
    auditLogs,
    transactions,
    create: new CreateCannedResponse(
      transactions.manager,
      repo,
      audit,
      sequentialIds(),
      clock,
    ),
    update: new UpdateCannedResponse(
      transactions.manager,
      repo,
      audit,
      fixedClock(DESPUES),
    ),
    remove: new DeleteCannedResponse(
      transactions.manager,
      repo,
      audit,
      fixedClock(DESPUES),
    ),
    list: new ListCannedResponses(repo),
  };
};

describe('CreateCannedResponse (ADR-0030)', () => {
  it('la crea, la guarda y la audita', async () => {
    const { create, repo, auditLogs } = montar();

    const r = await create.execute({
      tenantId: TENANT,
      actorId: ACTOR,
      title: ' Saludo ',
      body: 'Hola {{ticket.numero}}',
    });

    expect(r.isOk()).toBe(true);
    if (r.isErr()) return;
    expect(r.value.title).toBe('Saludo');
    expect(repo.stored(r.value.id)?.body).toBe('Hola {{ticket.numero}}');
    expect(auditLogs.entries).toHaveLength(1);
    expect(auditLogs.entries[0].action).toBe('canned_response.created');
    expect(auditLogs.entries[0].entityType).toBe('CannedResponse');
    expect(auditLogs.entries[0].entityId).toBe(r.value.id);
    expect(auditLogs.entries[0].metadata).toEqual({ title: 'Saludo' });
  });

  it('un título repetido con otras mayúsculas es un duplicado', async () => {
    const { create, repo, auditLogs } = montar();
    repo.seed(sembrada('Saludo'));

    const r = await create.execute({
      tenantId: TENANT,
      actorId: ACTOR,
      title: 'saludo',
      body: 'Otro texto',
    });

    expect(r.isErr()).toBe(true);
    if (r.isOk()) return;
    expect(r.error).toBeInstanceOf(DuplicateCannedResponseTitleError);
    expect(auditLogs.entries).toHaveLength(0);
  });

  it('un cuerpo con una variable desconocida no llega al repositorio', async () => {
    const { create, auditLogs } = montar();

    const r = await create.execute({
      tenantId: TENANT,
      actorId: ACTOR,
      title: 'Saludo',
      body: 'Hola {{clinete.email}}',
    });

    expect(r.isErr()).toBe(true);
    if (r.isOk()) return;
    expect(r.error).toBeInstanceOf(InvalidCannedResponseError);
    expect(auditLogs.entries).toHaveLength(0);
  });
});

describe('UpdateCannedResponse (ADR-0030)', () => {
  it('la reescribe y audita el antes y el después', async () => {
    const { update, repo, auditLogs } = montar();
    repo.seed(sembrada('Saludo'));

    const r = await update.execute({
      tenantId: TENANT,
      actorId: ACTOR,
      id: EXISTENTE,
      title: 'Bienvenida',
      body: 'Hola {{cliente.email}}',
    });

    expect(r.isOk()).toBe(true);
    const guardada = repo.stored(EXISTENTE);
    expect(guardada?.title).toBe('Bienvenida');
    expect(guardada?.updatedAt).toEqual(DESPUES);
    expect(auditLogs.entries).toHaveLength(1);
    expect(auditLogs.entries[0].action).toBe('canned_response.updated');
    expect(auditLogs.entries[0].metadata).toEqual({
      before: { title: 'Saludo', body: 'Hola' },
      after: { title: 'Bienvenida', body: 'Hola {{cliente.email}}' },
    });
  });

  it('cambiar solo las mayúsculas del propio título no es un duplicado', async () => {
    const { update, repo } = montar();
    repo.seed(sembrada('Saludo'));

    const r = await update.execute({
      tenantId: TENANT,
      actorId: ACTOR,
      id: EXISTENTE,
      title: 'saludo',
      body: 'Hola',
    });

    expect(r.isOk()).toBe(true);
    expect(repo.stored(EXISTENTE)?.title).toBe('saludo');
  });

  it('el título de OTRA plantilla es un duplicado', async () => {
    const { update, repo, auditLogs } = montar();
    repo.seed(sembrada('Saludo'));
    repo.seed(sembrada('Cierre', OTRA));

    const r = await update.execute({
      tenantId: TENANT,
      actorId: ACTOR,
      id: OTRA,
      title: 'SALUDO',
      body: 'Hola',
    });

    expect(r.isErr()).toBe(true);
    if (r.isOk()) return;
    expect(r.error).toBeInstanceOf(DuplicateCannedResponseTitleError);
    expect(repo.stored(OTRA)?.title).toBe('Cierre');
    expect(auditLogs.entries).toHaveLength(0);
  });

  it('una que no existe es not found', async () => {
    const { update } = montar();

    const r = await update.execute({
      tenantId: TENANT,
      actorId: ACTOR,
      id: NO_EXISTE,
      title: 'X',
      body: 'Y',
    });

    expect(r.isErr()).toBe(true);
    if (r.isOk()) return;
    expect(r.error).toBeInstanceOf(CannedResponseNotFoundError);
  });

  it('un cuerpo inválido no toca lo guardado', async () => {
    const { update, repo } = montar();
    repo.seed(sembrada('Saludo'));

    const r = await update.execute({
      tenantId: TENANT,
      actorId: ACTOR,
      id: EXISTENTE,
      title: 'Saludo',
      body: 'Hola {{',
    });

    expect(r.isErr()).toBe(true);
    if (r.isOk()) return;
    expect(r.error).toBeInstanceOf(InvalidCannedResponseError);
    expect(repo.stored(EXISTENTE)?.body).toBe('Hola');
  });
});

describe('DeleteCannedResponse (ADR-0030)', () => {
  it('la borra y deja en la auditoría qué se borró', async () => {
    const { remove, repo, auditLogs } = montar();
    repo.seed(sembrada('Saludo'));

    const r = await remove.execute({
      tenantId: TENANT,
      actorId: ACTOR,
      id: EXISTENTE,
    });

    expect(r.isOk()).toBe(true);
    expect(repo.stored(EXISTENTE)).toBeNull();
    expect(auditLogs.entries[0].action).toBe('canned_response.deleted');
    expect(auditLogs.entries[0].metadata).toEqual({
      title: 'Saludo',
      body: 'Hola',
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
    expect(r.error).toBeInstanceOf(CannedResponseNotFoundError);
    expect(auditLogs.entries).toHaveLength(0);
  });
});

describe('ListCannedResponses (ADR-0030)', () => {
  it('las devuelve ordenadas por título', async () => {
    const { list, repo } = montar();
    repo.seed(sembrada('saludo'));
    repo.seed(sembrada('Cierre', OTRA));

    const todas = await list.execute({ tenantId: TENANT });

    expect(todas.map((r) => r.title)).toEqual(['Cierre', 'saludo']);
  });
});
