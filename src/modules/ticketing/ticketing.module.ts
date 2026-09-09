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
  REALTIME_PUBLISHER,
  RealtimePublisher,
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
import { BroadcastTicketEvent } from './application/realtime/broadcast-ticket-event.use-case';
import { GetSlaPolicy } from './application/sla/get-sla-policy.use-case';
import { MarkSlaBreached } from './application/sla/mark-sla-breached.use-case';
import { ResetSlaPolicy } from './application/sla/reset-sla-policy.use-case';
import { StartSlaTimers } from './application/sla/start-sla-timers.use-case';
import { StopSlaTimer } from './application/sla/stop-sla-timer.use-case';
import { UpdateSlaPolicy } from './application/sla/update-sla-policy.use-case';
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
  SLA_POLICY_REPOSITORY,
  SLA_TIMER_REPOSITORY,
  SlaPolicyRepository,
  SlaTimerRepository,
} from './domain/ports/sla.repository';
import {
  TICKET_REPOSITORY,
  TicketRepository,
} from './domain/ports/ticket.repository';
import { SlaPolicyController } from './infrastructure/http/sla-policy.controller';
import { TicketController } from './infrastructure/http/ticket.controller';
import { RealtimeProcessor } from './infrastructure/queue/realtime.processor';
import { SlaProcessor } from './infrastructure/queue/sla.processor';
import { TicketRoutingProcessor } from './infrastructure/queue/ticket-routing.processor';
import { SlaSweeper } from './infrastructure/sla/sla-sweeper.service';
import { PrismaAuditLogRepository } from './infrastructure/persistence/prisma-audit-log.repository';
import { PrismaCommentRepository } from './infrastructure/persistence/prisma-comment.repository';
import { PrismaMemberDirectory } from './infrastructure/persistence/prisma-member.directory';
import { PrismaTicketNumberGenerator } from './infrastructure/persistence/prisma-ticket-number.generator';
import { PrismaTicketRepository } from './infrastructure/persistence/prisma-ticket.repository';
import {
  PrismaSlaPolicyRepository,
  PrismaSlaTimerRepository,
} from './infrastructure/persistence/prisma-sla.repository';
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
  controllers: [TicketController, SlaPolicyController],
  providers: [
    // --- Adapters ---
    PrismaTicketRepository,
    PrismaCommentRepository,
    PrismaAuditLogRepository,
    PrismaTicketNumberGenerator,
    PrismaMemberDirectory,
    TicketReadModel,
    PrismaSlaPolicyRepository,
    PrismaSlaTimerRepository,
    TicketRoutingProcessor,
    SlaProcessor,
    RealtimeProcessor,
    SlaSweeper,

    // --- Puertos -> adapters ---
    { provide: TICKET_REPOSITORY, useExisting: PrismaTicketRepository },
    { provide: COMMENT_REPOSITORY, useExisting: PrismaCommentRepository },
    { provide: AUDIT_LOG_REPOSITORY, useExisting: PrismaAuditLogRepository },
    {
      provide: TICKET_NUMBER_GENERATOR,
      useExisting: PrismaTicketNumberGenerator,
    },
    { provide: MEMBER_DIRECTORY, useExisting: PrismaMemberDirectory },
    { provide: SLA_POLICY_REPOSITORY, useExisting: PrismaSlaPolicyRepository },
    { provide: SLA_TIMER_REPOSITORY, useExisting: PrismaSlaTimerRepository },

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
      provide: StartSlaTimers,
      inject: [
        TRANSACTION_MANAGER,
        SLA_POLICY_REPOSITORY,
        SLA_TIMER_REPOSITORY,
        PROCESSED_MESSAGES,
        ID_GENERATOR,
      ],
      useFactory: (
        transactions: TransactionManager,
        policies: SlaPolicyRepository,
        timers: SlaTimerRepository,
        processed: ProcessedMessages,
        ids: IdGenerator,
      ): StartSlaTimers =>
        new StartSlaTimers(transactions, policies, timers, processed, ids),
    },
    {
      provide: BroadcastTicketEvent,
      inject: [REALTIME_PUBLISHER],
      useFactory: (realtime: RealtimePublisher): BroadcastTicketEvent =>
        new BroadcastTicketEvent(realtime),
    },
    {
      provide: GetSlaPolicy,
      inject: [SLA_POLICY_REPOSITORY],
      useFactory: (policies: SlaPolicyRepository): GetSlaPolicy =>
        new GetSlaPolicy(policies),
    },
    {
      provide: UpdateSlaPolicy,
      inject: [
        TRANSACTION_MANAGER,
        SLA_POLICY_REPOSITORY,
        AuditRecorder,
        CLOCK,
      ],
      useFactory: (
        transactions: TransactionManager,
        policies: SlaPolicyRepository,
        audit: AuditRecorder,
        clock: Clock,
      ): UpdateSlaPolicy =>
        new UpdateSlaPolicy(transactions, policies, audit, clock),
    },
    {
      provide: ResetSlaPolicy,
      inject: [
        TRANSACTION_MANAGER,
        SLA_POLICY_REPOSITORY,
        AuditRecorder,
        CLOCK,
      ],
      useFactory: (
        transactions: TransactionManager,
        policies: SlaPolicyRepository,
        audit: AuditRecorder,
        clock: Clock,
      ): ResetSlaPolicy =>
        new ResetSlaPolicy(transactions, policies, audit, clock),
    },
    {
      provide: StopSlaTimer,
      inject: [TRANSACTION_MANAGER, SLA_TIMER_REPOSITORY, PROCESSED_MESSAGES],
      useFactory: (
        transactions: TransactionManager,
        timers: SlaTimerRepository,
        processed: ProcessedMessages,
      ): StopSlaTimer => new StopSlaTimer(transactions, timers, processed),
    },
    {
      provide: MarkSlaBreached,
      inject: [
        TRANSACTION_MANAGER,
        SLA_TIMER_REPOSITORY,
        TICKET_REPOSITORY,
        AuditRecorder,
        EventRecorder,
        CLOCK,
      ],
      useFactory: (
        transactions: TransactionManager,
        timers: SlaTimerRepository,
        tickets: TicketRepository,
        audit: AuditRecorder,
        events: EventRecorder,
        clock: Clock,
      ): MarkSlaBreached =>
        new MarkSlaBreached(
          transactions,
          timers,
          tickets,
          audit,
          events,
          clock,
        ),
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
  exports: [AutoAssignTicket, SlaSweeper, StartSlaTimers, StopSlaTimer],
})
export class TicketingModule {}
