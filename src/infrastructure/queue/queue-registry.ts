import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import { SLA_QUEUE, TICKET_ROUTING_QUEUE } from './queues';

/**
 * Resuelve una cola por su nombre.
 *
 * Existe para que el publicador del outbox no tenga que conocer cada cola: le
 * basta con pedir la que dice el mapa de enrutado. Antes de la fase 6 el
 * publicador guardaba una referencia fija a la única cola que había —suficiente
 * entonces, insuficiente en cuanto apareció el segundo consumidor.
 *
 * Registrar una cola nueva es añadirla aquí y en `EVENT_ROUTING`; nada más del
 * publicador cambia.
 */
@Injectable()
export class QueueRegistry {
  private readonly byName: ReadonlyMap<string, Queue>;

  constructor(
    @InjectQueue(TICKET_ROUTING_QUEUE) routing: Queue,
    @InjectQueue(SLA_QUEUE) sla: Queue,
  ) {
    this.byName = new Map([
      [TICKET_ROUTING_QUEUE, routing],
      [SLA_QUEUE, sla],
    ]);
  }

  /** `null` si el nombre no corresponde a ninguna cola registrada. */
  get(name: string): Queue | null {
    return this.byName.get(name) ?? null;
  }
}
