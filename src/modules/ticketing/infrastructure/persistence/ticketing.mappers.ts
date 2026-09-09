import type {
  Comment as CommentRow,
  Ticket as TicketRow,
} from '@prisma/client';
import { Comment } from '../../domain/entities/comment.entity';
import { Ticket } from '../../domain/entities/ticket.entity';
import { CommentId, TenantId, TicketId, UserId } from '../../domain/ids';
import { isTicketPriority, isTicketStatus } from '../../domain/ticket-status';

/**
 * Mappers fila -> entidad de dominio.
 *
 * Lanzan en vez de devolver `Result` por el mismo motivo que los de `iam`: una
 * fila que no se puede convertir es una invariante rota (datos corruptos, una
 * migración a medias), no flujo de negocio que ningún caso de uso pueda manejar.
 *
 * Los enums de Prisma se ensanchan a `string` antes de estrecharlos con el type
 * guard del dominio: si se estrechara directamente el enum generado, la rama de
 * error quedaría tipada como `never` y no se podría ni interpolar el valor.
 */

export const toTicket = (row: TicketRow): Ticket => {
  const status: string = row.status;
  if (!isTicketStatus(status)) {
    throw new Error(
      `Estado de ticket desconocido en base de datos: "${status}".`,
    );
  }

  const priority: string = row.priority;
  if (!isTicketPriority(priority)) {
    throw new Error(
      `Prioridad de ticket desconocida en base de datos: "${priority}".`,
    );
  }

  return Ticket.rehydrate({
    id: TicketId(row.id),
    tenantId: TenantId(row.tenantId),
    number: row.number,
    subject: row.subject,
    description: row.description,
    status,
    priority,
    requesterId: UserId(row.requesterId),
    assigneeId: row.assigneeId === null ? null : UserId(row.assigneeId),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    resolvedAt: row.resolvedAt,
    closedAt: row.closedAt,
  });
};

export const toComment = (row: CommentRow): Comment =>
  Comment.rehydrate({
    id: CommentId(row.id),
    tenantId: TenantId(row.tenantId),
    ticketId: TicketId(row.ticketId),
    authorId: UserId(row.authorId),
    body: row.body,
    createdAt: row.createdAt,
  });
