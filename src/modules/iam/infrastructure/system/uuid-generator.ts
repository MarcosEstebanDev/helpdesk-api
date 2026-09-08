import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { IdGenerator } from '../../domain/ports/id-generator';

/** Adapter de {@link IdGenerator} sobre `crypto.randomUUID` (UUID v4). */
@Injectable()
export class UuidGenerator implements IdGenerator {
  uuid(): string {
    return randomUUID();
  }
}
