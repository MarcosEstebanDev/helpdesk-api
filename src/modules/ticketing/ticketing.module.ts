import { Module } from '@nestjs/common';
import {
  CLOCK,
  Clock,
  ID_GENERATOR,
  IdGenerator,
  OUTBOX_WRITER,
  OutboxWriter,
  PROCESSED_MESSAGES,
  ProcessedMessages,
  TRANSACTION_MANAGER,
  TransactionManager,
} from '../../shared-kernel';
import { IamModule } from '../iam/iam.module';
import { AddComment } from './application/add-comment.use-case';
import { AssignTicket } from './application/assign-ticket.use-case';
import { AutoAssignTicket } from './application/auto-assign-ticket.use-case';
import { AuditRecorder } from './application/audit-recorder';
import { ChangeTicketStatus } from './application/change-ticket-status.use-case';
import { EventRecorder } from './application/event-recorder';
import { CreateTicket } from './application/create-ticket.use-case';
import {
  AUDIT_LOG_REPOSITORY,
  AuditLogRepository,
} from './domain/ports/audit-log.repository';
import {
  COMMENT_REPOSITORY,
  CommentRepository,
} from './domain/ports/comment.repository';
import {
  MEMBER_DIRECTORY,
  MemberDirectory,
} from './domain/ports/member.directory';
import {
  TICKET_NUMBER_GENERATOR,
  TicketNumberGenerator,
} from './domain/ports/ticket-number.generator';
import {
  TICKET_REPOSITORY,
  TicketRepository,
} from './domain/ports/ticket.repository';
import { TicketController } from './infrastructure/http/ticket.controller';
import { TicketRoutingProcessor } from './infrastructure/queue/ticket-routing.processor';
import { PrismaAuditLogRepository } from './infrastructure/persistence/prisma-audit-log.repository';
import { PrismaCommentRepository } from './infrastructure/persistence/prisma-comment.repository';
import { PrismaMemberDirectory } from './infrastructure/persistence/prisma-member.directory';
import { PrismaTicketNumberGenerator } from './infrastructure/persistence/prisma-ticket-number.generator';
import { PrismaTicketRepository } from './infrastructure/persistence/prisma-ticket.repository';
import { TicketReadModel } from './infrastructure/persistence/ticket.read-model';

/**
 * Composición del bounded context Ticketing.
 *
 * Mismas dos reglas que `IamModule`: los casos de uso son clases PURAS —sin
 * decoradores de Nest— construidas con `useFactory` e inyectando por el TOKEN
 * del puerto, y ningún caso de uso conoce un adapter concreto.
 *
 * Importa `IamModule` únicamente por `JwtAuthGuard`, que el controller usa para
 * exigir sesión. La pertenencia a la organización NO se consulta importando los
 * repositorios de `iam`, sino a través del puerto `MemberDirectory`: así el
 * acoplamiento entre contextos queda en un solo adapter.
 *
 * `CLOCK`, `ID_GENERATOR` y `TRANSACTION_MANAGER` llegan de los módulos globales
 * (`SystemModule` y `PrismaModule`).
 */
@Module({
  imports: [IamModule],
  controllers: [TicketController],
  providers: [
    // --- Adapters ---
    PrismaTicketRepository,
    PrismaCommentRepository,
    PrismaAuditLogRepository,
    PrismaTicketNumberGenerator,
    PrismaMemberDirectory,
    TicketReadModel,
    TicketRoutingProcessor,

    // --- Puertos -> adapters ---
    { provide: TICKET_REPOSITORY, useExisting: PrismaTicketRepository },
    { provide: COMMENT_REPOSITORY, useExisting: PrismaCommentRepository },
    { provide: AUDIT_LOG_REPOSITORY, useExisting: PrismaAuditLogRepository },
    {
      provide: TICKET_NUMBER_GENERATOR,
      useExisting: PrismaTicketNumberGenerator,
    },
    { provide: MEMBER_DIRECTORY, useExisting: PrismaMemberDirectory },

    // --- Aplicación (clases puras, construidas a mano) ---
    {
      provide: AuditRecorder,
      inject: [ID_GENERATOR, AUDIT_LOG_REPOSITORY],
      useFactory: (
        ids: IdGenerator,
        auditLogs: AuditLogRepository,
      ): AuditRecorder => new AuditRecorder(ids, auditLogs),
    },
    {
      provide: EventRecorder,
      inject: [ID_GENERATOR, OUTBOX_WRITER],
      useFactory: (ids: IdGenerator, outbox: OutboxWriter): EventRecorder =>
        new EventRecorder(ids, outbox),
    },
    {
      provide: CreateTicket,
      inject: [
        TRANSACTION_MANAGER,
        TICKET_REPOSITORY,
        TICKET_NUMBER_GENERATOR,
        AuditRecorder,
        EventRecorder,
        ID_GENERATOR,
        CLOCK,
      ],
      useFactory: (
        transactions: TransactionManager,
        tickets: TicketRepository,
        numbers: TicketNumberGenerator,
        audit: AuditRecorder,
        events: EventRecorder,
        ids: IdGenerator,
        clock: Clock,
      ): CreateTicket =>
        new CreateTicket(
          transactions,
          tickets,
          numbers,
          audit,
          events,
          ids,
          clock,
        ),
    },
    {
      provide: AssignTicket,
      inject: [
        TRANSACTION_MANAGER,
        TICKET_REPOSITORY,
        MEMBER_DIRECTORY,
        AuditRecorder,
        EventRecorder,
        CLOCK,
      ],
      useFactory: (
        transactions: TransactionManager,
        tickets: TicketRepository,
        members: MemberDirectory,
        audit: AuditRecorder,
        events: EventRecorder,
        clock: Clock,
      ): AssignTicket =>
        new AssignTicket(transactions, tickets, members, audit, events, clock),
    },
    {
      provide: AutoAssignTicket,
      inject: [
        TRANSACTION_MANAGER,
        TICKET_REPOSITORY,
        MEMBER_DIRECTORY,
        PROCESSED_MESSAGES,
        AuditRecorder,
        EventRecorder,
        CLOCK,
      ],
      useFactory: (
        transactions: TransactionManager,
        tickets: TicketRepository,
        members: MemberDirectory,
        processed: ProcessedMessages,
        audit: AuditRecorder,
        events: EventRecorder,
        clock: Clock,
      ): AutoAssignTicket =>
        new AutoAssignTicket(
          transactions,
          tickets,
          members,
          processed,
          audit,
          events,
          clock,
        ),
    },
    {
      provide: ChangeTicketStatus,
      inject: [
        TRANSACTION_MANAGER,
        TICKET_REPOSITORY,
        AuditRecorder,
        EventRecorder,
        CLOCK,
      ],
      useFactory: (
        transactions: TransactionManager,
        tickets: TicketRepository,
        audit: AuditRecorder,
        events: EventRecorder,
        clock: Clock,
      ): ChangeTicketStatus =>
        new ChangeTicketStatus(transactions, tickets, audit, events, clock),
    },
    {
      provide: AddComment,
      inject: [
        TRANSACTION_MANAGER,
        TICKET_REPOSITORY,
        COMMENT_REPOSITORY,
        AuditRecorder,
        EventRecorder,
        ID_GENERATOR,
        CLOCK,
      ],
      useFactory: (
        transactions: TransactionManager,
        tickets: TicketRepository,
        comments: CommentRepository,
        audit: AuditRecorder,
        events: EventRecorder,
        ids: IdGenerator,
        clock: Clock,
      ): AddComment =>
        new AddComment(
          transactions,
          tickets,
          comments,
          audit,
          events,
          ids,
          clock,
        ),
    },
  ],
  // El publicador del outbox (fase 5b) lo necesita para dirigirlo desde los e2e.
  exports: [AutoAssignTicket],
})
export class TicketingModule {}
