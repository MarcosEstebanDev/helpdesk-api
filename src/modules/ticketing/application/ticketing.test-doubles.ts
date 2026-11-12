import {
  Clock,
  IdGenerator,
  OutboxRecord,
  OutboxWriter,
  ProcessedMessages,
  RealtimeAudience,
  RealtimeMessage,
  RealtimePublisher,
  TransactionManager,
  err,
  ok,
} from '../../../shared-kernel';
import { TriageRejectedError, TriageUnavailableError } from '../domain/errors';
import {
  ClassifierOutput,
  TicketClassifier,
} from '../domain/ports/ticket-classifier';
import { TicketTriageRepository } from '../domain/ports/ticket-triage.repository';
import { TicketTriage } from '../domain/triage/ticket-triage.entity';
import { AuditLog } from '../domain/entities/audit-log.entity';
import { Comment } from '../domain/entities/comment.entity';
import { Ticket } from '../domain/entities/ticket.entity';
import { CannedResponse } from '../domain/canned-response/canned-response.entity';
import { CannedResponseRepository } from '../domain/ports/canned-response.repository';
import {
  CannedResponseId,
  TagId,
  TenantId,
  TicketId,
  UserId,
} from '../domain/ids';
import { Tag } from '../domain/tag/tag.entity';
import { TagRepository } from '../domain/ports/tag.repository';
import { TicketTagRepository } from '../domain/ports/ticket-tag.repository';
import { AuditLogRepository } from '../domain/ports/audit-log.repository';
import { CommentRepository } from '../domain/ports/comment.repository';
import { MemberDirectory } from '../domain/ports/member.directory';
import {
  SlaPolicyRepository,
  SlaTimerRepository,
} from '../domain/ports/sla.repository';
import { SlaTarget } from '../domain/sla/sla-policy';
import { SlaKind, SlaTimer } from '../domain/sla/sla-timer.entity';
import { TicketPriority } from '../domain/ticket-status';
import { TicketNumberGenerator } from '../domain/ports/ticket-number.generator';
import { TicketRepository } from '../domain/ports/ticket.repository';

/**
 * Dobles de prueba compartidos por los tests de casos de uso de ticketing.
 *
 * Son implementaciones en memoria de los PUERTOS, no mocks de Prisma: esa es la
 * ventaja concreta de la arquitectura hexagonal en esta capa. Los casos de uso se
 * testean completos —con su lógica de orquestación— sin base de datos, en
 * milisegundos y sin flakiness.
 *
 * Vive en un `.ts` normal y no en un `.spec.ts` porque Jest trata como suite
 * cualquier fichero que case con el testRegex, y un fichero sin `it()` fallaría.
 */

export const TENANT = TenantId('11111111-1111-1111-1111-111111111111');
export const OTRO_TENANT = TenantId('99999999-9999-9999-9999-999999999999');
export const ACTOR = UserId('22222222-2222-2222-2222-222222222222');
export const AGENTE = UserId('33333333-3333-3333-3333-333333333333');
export const AJENO = UserId('88888888-8888-8888-8888-888888888888');
export const AHORA = new Date('2026-09-09T10:00:00Z');

export const fixedClock = (now: Date = AHORA): Clock => ({ now: () => now });

/** Ids deterministas: uuid-1, uuid-2, … para poder afirmar sobre ellos. */
export const sequentialIds = (): IdGenerator => {
  let seq = 0;
  return {
    uuid: () => {
      seq += 1;
      return `00000000-0000-0000-0000-${String(seq).padStart(12, '0')}`;
    },
  };
};

export interface FakeTransactions {
  manager: TransactionManager;
  readonly commits: number;
  readonly rollbacks: number;
}

export const fakeTransactions = (): FakeTransactions => {
  const state = { commits: 0, rollbacks: 0 };
  return {
    manager: {
      run: async <T>(_tenantId: string, fn: () => Promise<T>): Promise<T> => {
        try {
          const result = await fn();
          state.commits += 1;
          return result;
        } catch (error) {
          state.rollbacks += 1;
          throw error;
        }
      },
    },
    get commits() {
      return state.commits;
    },
    get rollbacks() {
      return state.rollbacks;
    },
  };
};

export interface FakeTicketRepository extends TicketRepository {
  readonly saved: Ticket[];
  /** Cuántas veces se leyó un ticket con `findByIdForUpdate`. */
  readonly lockedReads: number;
  seed(ticket: Ticket): void;
}

export const fakeTicketRepository = (): FakeTicketRepository => {
  const store = new Map<string, Ticket>();
  const saved: Ticket[] = [];
  const state = { lockedReads: 0 };

  return {
    saved,
    seed: (ticket) => {
      store.set(`${ticket.tenantId}:${ticket.id}`, ticket);
    },
    save: (ticket) => {
      store.set(`${ticket.tenantId}:${ticket.id}`, ticket);
      saved.push(ticket);
      return Promise.resolve();
    },
    // La clave incluye el tenant: así el doble reproduce el aislamiento que en
    // producción impone RLS, y un test que lo rompa falla aquí y no en los e2e.
    findById: (tenantId: TenantId, id: TicketId) =>
      Promise.resolve(store.get(`${tenantId}:${id}`) ?? null),
    findByIdForUpdate: (tenantId: TenantId, id: TicketId) => {
      state.lockedReads += 1;
      return Promise.resolve(store.get(`${tenantId}:${id}`) ?? null);
    },
    get lockedReads() {
      return state.lockedReads;
    },
  };
};

export interface FakeAuditLogRepository extends AuditLogRepository {
  readonly entries: AuditLog[];
}

export const fakeAuditLogRepository = (): FakeAuditLogRepository => {
  const entries: AuditLog[] = [];
  return {
    entries,
    record: (entry) => {
      entries.push(entry);
      return Promise.resolve();
    },
  };
};

export interface FakeCommentRepository extends CommentRepository {
  readonly comments: Comment[];
}

export const fakeCommentRepository = (): FakeCommentRepository => {
  const comments: Comment[] = [];
  return {
    comments,
    save: (comment) => {
      comments.push(comment);
      return Promise.resolve();
    },
  };
};

export interface FakeNumberGenerator extends TicketNumberGenerator {
  readonly calls: number;
}

export const fakeNumberGenerator = (start = 1): FakeNumberGenerator => {
  const state = { next: start, calls: 0 };
  return {
    next: () => {
      state.calls += 1;
      const assigned = state.next;
      state.next += 1;
      return Promise.resolve(assigned);
    },
    get calls() {
      return state.calls;
    },
  };
};

/**
 * Directorio que solo reconoce a los usuarios que se le pasan. `agents` son los
 * que además pueden atender tickets; por defecto, todos.
 */
export const fakeMemberDirectory = (
  members: readonly UserId[],
  agents: readonly UserId[] = members,
): MemberDirectory => ({
  isMember: (_tenantId, userId) => Promise.resolve(members.includes(userId)),
  agentsOf: () => Promise.resolve([...agents]),
});

export interface FakeOutbox extends OutboxWriter {
  readonly records: OutboxRecord[];
}

/** Outbox en memoria: permite afirmar QUÉ eventos se habrían publicado. */
export const fakeOutbox = (): FakeOutbox => {
  const records: OutboxRecord[] = [];
  return {
    records,
    append: (batch) => {
      records.push(...batch);
      return Promise.resolve();
    },
  };
};

export interface FakeProcessedMessages extends ProcessedMessages {
  readonly claims: string[];
}

/**
 * Idempotencia en memoria. Imita la clave primaria `(consumer, event_id)`: el
 * primer `claim` de un par devuelve true y los siguientes false.
 */
export const fakeProcessedMessages = (
  yaProcesados: readonly string[] = [],
): FakeProcessedMessages => {
  const vistos = new Set(yaProcesados);
  const claims: string[] = [];
  return {
    claims,
    claim: ({ consumer, eventId }) => {
      const clave = `${consumer}:${eventId}`;
      claims.push(clave);
      if (vistos.has(clave)) {
        return Promise.resolve(false);
      }
      vistos.add(clave);
      return Promise.resolve(true);
    },
  };
};

/** Política de SLA en memoria: por defecto, sin ningún override. */
export interface FakeSlaPolicies extends SlaPolicyRepository {
  /** Lo que hay configurado ahora mismo, para afirmar sobre ello. */
  readonly overrides: Partial<Record<TicketPriority, SlaTarget>>;
  readonly upserts: number;
}

export const fakeSlaPolicies = (
  iniciales: Partial<Record<TicketPriority, SlaTarget>> = {},
): FakeSlaPolicies => {
  const overrides: Partial<Record<TicketPriority, SlaTarget>> = {
    ...iniciales,
  };
  const state = { upserts: 0 };

  return {
    overrides,
    get upserts() {
      return state.upserts;
    },
    // Copia defensiva: el caso de uso no debe poder mutar el almacen por
    // referencia, igual que no podria con una fila de Postgres.
    overridesOf: () => Promise.resolve({ ...overrides }),
    upsert: (input) => {
      overrides[input.priority] = input.target;
      state.upserts += 1;
      return Promise.resolve();
    },
    remove: (_tenantId, priority) => {
      const habia = overrides[priority] !== undefined;
      delete overrides[priority];
      return Promise.resolve(habia);
    },
  };
};

export interface FakeSlaTimers extends SlaTimerRepository {
  /** Escrituras que APLICARON (altas y transiciones), en orden. */
  readonly saved: SlaTimer[];
  seed(timer: SlaTimer): void;
  /** Lo guardado ahora mismo para ese id, como lo vería una lectura nueva. */
  stored(id: string): SlaTimer | null;
  /** La próxima `transition` pierde la carrera contra otra escritura. */
  loseNextTransition(): void;
}

/**
 * Guarda COPIAS, como una base de datos: si devolviera la misma instancia, el
 * caso de uso la mutaría antes de `transition` y la condición compararía contra
 * el estado ya cambiado, así que el doble nunca podría decir que no.
 */
export const fakeSlaTimers = (): FakeSlaTimers => {
  const store = new Map<string, SlaTimer>();
  const saved: SlaTimer[] = [];
  let perderSiguiente = false;
  const clave = (tenantId: string, id: string) => `${tenantId}:${id}`;
  const copia = (t: SlaTimer): SlaTimer =>
    SlaTimer.rehydrate({
      id: t.id,
      tenantId: t.tenantId,
      ticketId: t.ticketId,
      kind: t.kind,
      startedAt: t.startedAt,
      dueAt: t.dueAt,
      stoppedAt: t.stoppedAt,
      breachedAt: t.breachedAt,
      pausedAt: t.pausedAt,
    });

  return {
    saved,
    seed: (timer) => {
      store.set(clave(timer.tenantId, timer.id), copia(timer));
    },
    stored: (id) => {
      const t = [...store.values()].find((x) => x.id === id);
      return t === undefined ? null : copia(t);
    },
    loseNextTransition: () => {
      perderSiguiente = true;
    },
    save: (timer) => {
      store.set(clave(timer.tenantId, timer.id), copia(timer));
      saved.push(copia(timer));
      return Promise.resolve();
    },
    transition: (timer, expected) => {
      const k = clave(timer.tenantId, timer.id);
      const actual = store.get(k);
      const coincide =
        actual !== undefined &&
        (expected === 'running' ? actual.isRunning() : actual.isPaused());
      if (perderSiguiente || !coincide) {
        perderSiguiente = false;
        return Promise.resolve(false);
      }
      store.set(k, copia(timer));
      saved.push(copia(timer));
      return Promise.resolve(true);
    },
    findByTicket: (tenantId, ticketId) =>
      Promise.resolve(
        [...store.values()]
          .filter((t) => t.tenantId === tenantId && t.ticketId === ticketId)
          .map(copia),
      ),
    findOpen: (tenantId, ticketId, kind: SlaKind) => {
      const t = [...store.values()].find(
        (x) =>
          x.tenantId === tenantId &&
          x.ticketId === ticketId &&
          x.kind === kind &&
          x.isOpen(),
      );
      return Promise.resolve(t === undefined ? null : copia(t));
    },
    findById: (tenantId, id) => {
      const t = store.get(clave(tenantId, id));
      return Promise.resolve(t === undefined ? null : copia(t));
    },
  };
};

export interface FakeTicketTriages extends TicketTriageRepository {
  readonly saved: TicketTriage[];
}

/** Imita la PK por ticket: la primera sugerencia gana, igual que en Postgres. */
export const fakeTicketTriages = (): FakeTicketTriages => {
  const store = new Map<string, TicketTriage>();
  const saved: TicketTriage[] = [];
  return {
    saved,
    save: (triage) => {
      const clave = `${triage.tenantId}:${triage.ticketId}`;
      if (!store.has(clave)) store.set(clave, triage);
      saved.push(triage);
      return Promise.resolve();
    },
    findByTicket: (tenantId, ticketId) =>
      Promise.resolve(store.get(`${tenantId}:${ticketId}`) ?? null),
  };
};

export const CLASIFICACION_EJEMPLO: ClassifierOutput = {
  classification: {
    category: 'billing',
    suggestedPriority: 'HIGH',
    sentiment: 'negative',
    language: 'es',
  },
  provenance: {
    provider: 'fake',
    model: 'fake-model',
    promptVersion: 'triage-v1',
    latencyMs: 42,
    inputTokens: 300,
    outputTokens: 30,
  },
};

export interface FakeClassifier extends TicketClassifier {
  readonly calls: { subject: string; description: string }[];
}

/** Clasificador que responde lo que se le diga, o el error que se le pase. */
export const fakeClassifier = (
  respuesta:
    | ClassifierOutput
    | TriageUnavailableError
    | TriageRejectedError = CLASIFICACION_EJEMPLO,
): FakeClassifier => {
  const calls: { subject: string; description: string }[] = [];
  return {
    calls,
    classify: (input) => {
      calls.push(input);
      return Promise.resolve(
        respuesta instanceof TriageUnavailableError ||
          respuesta instanceof TriageRejectedError
          ? err(respuesta)
          : ok(respuesta),
      );
    },
  };
};

/** Una emisión de tiempo real capturada por el doble. */
export interface EmisionCapturada {
  audience: RealtimeAudience;
  message: RealtimeMessage;
}

export interface FakeRealtimePublisher extends RealtimePublisher {
  readonly emisiones: EmisionCapturada[];
  /** Las emisiones dirigidas a un alcance concreto. */
  para(scope: RealtimeAudience['scope']): EmisionCapturada[];
}

export const fakeRealtimePublisher = (): FakeRealtimePublisher => {
  const emisiones: EmisionCapturada[] = [];
  return {
    emisiones,
    para: (scope) => emisiones.filter((e) => e.audience.scope === scope),
    publish: (audience, message) => {
      emisiones.push({ audience, message });
      return Promise.resolve();
    },
  };
};

export interface FakeCannedResponses extends CannedResponseRepository {
  seed(response: CannedResponse): void;
  /** Lo guardado ahora para ese id, como lo vería una lectura nueva. */
  stored(id: string): CannedResponse | null;
}

/**
 * Guarda COPIAS, como `fakeSlaTimers`: si devolviera la misma instancia, una
 * reescritura que el caso de uso descarta quedaría "guardada" igual.
 * La clave lleva el tenant para reproducir el aislamiento de RLS.
 */
export const fakeCannedResponses = (): FakeCannedResponses => {
  const store = new Map<string, CannedResponse>();
  const clave = (tenantId: string, id: string) => `${tenantId}:${id}`;
  const copia = (r: CannedResponse) =>
    CannedResponse.rehydrate({
      id: r.id,
      tenantId: r.tenantId,
      title: r.title,
      titleKey: r.titleKey,
      body: r.body,
      createdBy: r.createdBy,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    });
  const guardar = (r: CannedResponse) => {
    store.set(clave(r.tenantId, r.id), copia(r));
    return Promise.resolve();
  };

  return {
    seed: (r) => void guardar(r),
    stored: (id) => {
      for (const r of store.values()) if (r.id === id) return copia(r);
      return null;
    },
    list: (tenantId: TenantId) =>
      Promise.resolve(
        [...store.values()]
          .filter((r) => r.tenantId === tenantId)
          .sort((a, b) => a.titleKey.localeCompare(b.titleKey))
          .map(copia),
      ),
    findById: (tenantId: TenantId, id: CannedResponseId) => {
      const r = store.get(clave(tenantId, id));
      return Promise.resolve(r ? copia(r) : null);
    },
    existsTitleKey: (tenantId, titleKey, exceptId) =>
      Promise.resolve(
        [...store.values()].some(
          (r) =>
            r.tenantId === tenantId &&
            r.titleKey === titleKey &&
            r.id !== exceptId,
        ),
      ),
    insert: guardar,
    update: guardar,
    remove: (tenantId, id) =>
      Promise.resolve(store.delete(clave(tenantId, id))),
  };
};

export interface FakeTags extends TagRepository {
  seed(tag: Tag): void;
  stored(id: string): Tag | null;
}

/** Catálogo en memoria; guarda COPIAS y la clave lleva el tenant (RLS). */
export const fakeTags = (): FakeTags => {
  const store = new Map<string, Tag>();
  const clave = (tenantId: string, id: string) => `${tenantId}:${id}`;
  const copia = (t: Tag) =>
    Tag.rehydrate({
      id: t.id,
      tenantId: t.tenantId,
      name: t.name,
      nameKey: t.nameKey,
      color: t.color,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    });
  const guardar = (t: Tag) => {
    store.set(clave(t.tenantId, t.id), copia(t));
    return Promise.resolve();
  };

  return {
    seed: (t) => void guardar(t),
    stored: (id) => {
      for (const t of store.values()) if (t.id === id) return copia(t);
      return null;
    },
    list: (tenantId) =>
      Promise.resolve(
        [...store.values()]
          .filter((t) => t.tenantId === tenantId)
          .sort((a, b) => a.nameKey.localeCompare(b.nameKey))
          .map(copia),
      ),
    findById: (tenantId, id) => {
      const t = store.get(clave(tenantId, id));
      return Promise.resolve(t ? copia(t) : null);
    },
    findByIds: (tenantId, ids) =>
      Promise.resolve(
        ids
          .map((id) => store.get(clave(tenantId, id)))
          .filter((t): t is Tag => t !== undefined)
          .map(copia),
      ),
    existsNameKey: (tenantId, nameKey, exceptId) =>
      Promise.resolve(
        [...store.values()].some(
          (t) =>
            t.tenantId === tenantId &&
            t.nameKey === nameKey &&
            t.id !== exceptId,
        ),
      ),
    insert: guardar,
    update: guardar,
    remove: (tenantId, id) =>
      Promise.resolve(store.delete(clave(tenantId, id))),
  };
};

export interface FakeTicketTags extends TicketTagRepository {
  readonly replaces: number;
  seed(tenantId: TenantId, ticketId: TicketId, tagIds: TagId[]): void;
}

export const fakeTicketTags = (): FakeTicketTags => {
  const store = new Map<string, TagId[]>();
  const state = { replaces: 0 };
  const clave = (tenantId: string, ticketId: string) =>
    `${tenantId}:${ticketId}`;
  return {
    get replaces() {
      return state.replaces;
    },
    seed: (tenantId, ticketId, tagIds) => {
      store.set(clave(tenantId, ticketId), [...tagIds]);
    },
    tagsOf: (tenantId, ticketId) =>
      Promise.resolve([...(store.get(clave(tenantId, ticketId)) ?? [])]),
    replace: (tenantId, ticketId, tagIds) => {
      store.set(clave(tenantId, ticketId), [...tagIds]);
      state.replaces += 1;
      return Promise.resolve();
    },
  };
};
