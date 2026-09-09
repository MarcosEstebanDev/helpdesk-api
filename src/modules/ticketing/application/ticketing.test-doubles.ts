import {
  Clock,
  IdGenerator,
  OutboxRecord,
  OutboxWriter,
  TransactionManager,
} from '../../../shared-kernel';
import { AuditLog } from '../domain/entities/audit-log.entity';
import { Comment } from '../domain/entities/comment.entity';
import { Ticket } from '../domain/entities/ticket.entity';
import { TenantId, TicketId, UserId } from '../domain/ids';
import { AuditLogRepository } from '../domain/ports/audit-log.repository';
import { CommentRepository } from '../domain/ports/comment.repository';
import { MemberDirectory } from '../domain/ports/member.directory';
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
  seed(ticket: Ticket): void;
}

export const fakeTicketRepository = (): FakeTicketRepository => {
  const store = new Map<string, Ticket>();
  const saved: Ticket[] = [];

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

/** Directorio que solo reconoce a los usuarios que se le pasan. */
export const fakeMemberDirectory = (
  members: readonly UserId[],
): MemberDirectory => ({
  isMember: (_tenantId, userId) => Promise.resolve(members.includes(userId)),
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
