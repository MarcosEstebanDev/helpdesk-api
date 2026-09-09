import { Module } from '@nestjs/common';
import { OutboxPublisher } from './outbox-publisher.service';
import { OutboxReader } from './outbox-reader';

/**
 * El publicador del outbox. Se exporta para que los tests e2e puedan pedirle un
 * ciclo concreto en vez de esperar a que salte su temporizador.
 */
@Module({
  providers: [OutboxReader, OutboxPublisher],
  exports: [OutboxPublisher, OutboxReader],
})
export class OutboxModule {}
