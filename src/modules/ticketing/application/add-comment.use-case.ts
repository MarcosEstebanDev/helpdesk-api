import {
  Clock,
  IdGenerator,
  Result,
  TransactionManager,
  err,
  ok,
} from '../../../shared-kernel';
import { Comment } from '../domain/entities/comment.entity';
import {
  TicketClosedError,
  TicketNotFoundError,
  TicketingError,
} from '../domain/errors';
import { CommentId, TenantId, TicketId, UserId } from '../domain/ids';
import { CommentRepository } from '../domain/ports/comment.repository';
import { TicketRepository } from '../domain/ports/ticket.repository';
import { AuditRecorder } from './audit-recorder';
import { EventRecorder } from './event-recorder';
import { runTransactional } from './transactional';

export interface AddCommentInput {
  tenantId: TenantId;
  actorId: UserId;
  ticketId: TicketId;
  body: string;
}

/**
 * Añade un comentario a un ticket.
 *
 * Se carga el ticket aunque solo se vaya a insertar en `comments`: es la única
 * forma de saber si existe y si sigue admitiendo conversación. Sin esa lectura,
 * comentar en un ticket inexistente fallaría por clave foránea (un 500) y
 * comentar en uno cerrado funcionaría sin más.
 */
export class AddComment {
  constructor(
    private readonly transactions: TransactionManager,
    private readonly tickets: TicketRepository,
    private readonly comments: CommentRepository,
    private readonly audit: AuditRecorder,
    private readonly events: EventRecorder,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async execute(
    input: AddCommentInput,
  ): Promise<Result<Comment, TicketingError>> {
    const now = this.clock.now();

    return runTransactional(this.transactions, input.tenantId, async () => {
      const ticket = await this.tickets.findById(
        input.tenantId,
        input.ticketId,
      );
      if (ticket === null) {
        return err(new TicketNotFoundError());
      }
      if (!ticket.acceptsComments()) {
        return err(new TicketClosedError());
      }

      const written = Comment.write({
        id: CommentId(this.ids.uuid()),
        tenantId: input.tenantId,
        ticketId: input.ticketId,
        authorId: input.actorId,
        body: input.body,
        now,
      });
      if (written.isErr()) {
        return err(written.error);
      }

      const comment = written.value;

      // Comentar es actividad SOBRE el ticket: la raíz del agregado lo registra,
      // actualiza su `updatedAt` y emite el evento. Vuelve a comprobar que el
      // ticket admite comentarios —de ahí que se maneje su `Result`— aunque a
      // estas alturas ya sabemos que sí; la entidad no confía en el llamador.
      const registered = ticket.registerComment(comment.id, input.actorId, now);
      if (registered.isErr()) {
        return err(registered.error);
      }

      await this.comments.save(comment);
      await this.tickets.save(ticket);
      await this.audit.record({
        tenantId: input.tenantId,
        actorId: input.actorId,
        action: 'comment.added',
        entityType: 'ticket',
        entityId: ticket.id,
        metadata: { commentId: comment.id },
        now,
      });
      await this.events.record(ticket);

      return ok(comment);
    });
  }
}
