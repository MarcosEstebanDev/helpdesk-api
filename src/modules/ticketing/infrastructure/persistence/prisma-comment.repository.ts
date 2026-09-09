import { Injectable } from '@nestjs/common';
import { PrismaRepository } from '../../../../infrastructure/prisma/prisma.repository';
import { PrismaService } from '../../../../infrastructure/prisma/prisma.service';
import { Comment } from '../../domain/entities/comment.entity';
import { CommentRepository } from '../../domain/ports/comment.repository';

@Injectable()
export class PrismaCommentRepository
  extends PrismaRepository
  implements CommentRepository
{
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  async save(comment: Comment): Promise<void> {
    await this.runInTenant(comment.tenantId, async (tx) => {
      await tx.comment.create({
        data: {
          id: comment.id,
          tenantId: comment.tenantId,
          ticketId: comment.ticketId,
          authorId: comment.authorId,
          body: comment.body,
          createdAt: comment.createdAt,
        },
      });
    });
  }
}
