import { Comment } from '../entities/comment.entity';

export interface CommentRepository {
  save(comment: Comment): Promise<void>;
}

export const COMMENT_REPOSITORY = Symbol('ticketing.CommentRepository');
