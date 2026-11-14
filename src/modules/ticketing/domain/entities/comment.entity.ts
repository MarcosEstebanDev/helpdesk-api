import { Entity, Result, err, ok } from '../../../../shared-kernel';
import { CommentVisibility, isStaff } from '../comment-visibility';
import {
  EmptyCommentError,
  InternalNoteForbiddenError,
  TicketingError,
} from '../errors';
import { CommentId, TenantId, TicketId, UserId } from '../ids';

const BODY_MAX = 10_000;

interface CommentProps {
  tenantId: TenantId;
  ticketId: TicketId;
  authorId: UserId;
  body: string;
  visibility: CommentVisibility;
  createdAt: Date;
}

/**
 * Comentario de un ticket. Es INMUTABLE: no hay editar ni borrar.
 *
 * Es una decisión de producto, no una simplificación: la conversación de un
 * ticket es también su rastro de lo ocurrido, y permitir reescribirla haría que
 * el `AuditLog` (ADR-0016) contara una historia y los comentarios otra.
 *
 * La visibilidad (ADR-0028) es parte de esa inmutabilidad: una nota interna no
 * se "publica" después. Si se pudiera, lo que vio el cliente y lo que cuenta la
 * auditoría dejarían de coincidir.
 */
export class Comment extends Entity<CommentId> {
  private constructor(
    id: CommentId,
    private readonly props: CommentProps,
  ) {
    super(id);
  }

  get tenantId(): TenantId {
    return this.props.tenantId;
  }

  get ticketId(): TicketId {
    return this.props.ticketId;
  }

  get authorId(): UserId {
    return this.props.authorId;
  }

  get body(): string {
    return this.props.body;
  }

  get visibility(): CommentVisibility {
    return this.props.visibility;
  }

  get createdAt(): Date {
    return this.props.createdAt;
  }

  static write(input: {
    id: CommentId;
    tenantId: TenantId;
    ticketId: TicketId;
    authorId: UserId;
    /** Rol del autor AL escribir, del token verificado: decide si puede dejar una nota interna. */
    authorRole: string;
    body: string;
    visibility: CommentVisibility;
    now: Date;
  }): Result<Comment, TicketingError> {
    if (input.visibility === 'INTERNAL' && !isStaff(input.authorRole)) {
      return err(new InternalNoteForbiddenError());
    }

    const body = input.body.trim();
    if (body.length === 0 || body.length > BODY_MAX) {
      return err(new EmptyCommentError());
    }

    return ok(
      new Comment(input.id, {
        tenantId: input.tenantId,
        ticketId: input.ticketId,
        authorId: input.authorId,
        body,
        visibility: input.visibility,
        createdAt: input.now,
      }),
    );
  }

  static rehydrate(input: { id: CommentId } & CommentProps): Comment {
    const { id, ...props } = input;
    return new Comment(id, { ...props });
  }
}
