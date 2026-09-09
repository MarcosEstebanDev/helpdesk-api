import { Injectable } from '@nestjs/common';
import { Clock } from '../../shared-kernel';

/** Adapter de {@link Clock} sobre el reloj real. */
@Injectable()
export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}
