import { CannedResponse } from '../../domain/canned-response/canned-response.entity';
import {
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

const AHORA = new Date('2026-11-12T10:00:00.000Z');
const EXISTENTE = CannedResponseId('77777777-7777-7777-7777-777777777777');

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
