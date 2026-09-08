import { Injectable } from '@nestjs/common';
import { Clock } from '../../domain/ports/clock';

/** Adapter de {@link Clock} sobre el reloj real. */
@Injectable()
export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}
