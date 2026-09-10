import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import {
  HealthIndicatorResult,
  HealthIndicatorService,
} from '@nestjs/terminus';
import { Queue } from 'bullmq';
import { TICKET_ROUTING_QUEUE } from '../../../../infrastructure/queue/queues';

/**
 * Salud de Redis, medida a través de una cola de BullMQ.
 *
 * Se reutiliza la conexión que ya usa la aplicación en vez de abrir un cliente
 * propio: una conexión nueva podría funcionar mientras la del pool de BullMQ
 * está rota, y entonces la sonda diría que todo va bien justo cuando los jobs
 * han dejado de procesarse. Se comprueba lo que se usa, no lo que se parece a
 * lo que se usa.
 */
@Injectable()
export class RedisHealthIndicator {
  constructor(
    private readonly indicators: HealthIndicatorService,
    @InjectQueue(TICKET_ROUTING_QUEUE) private readonly queue: Queue,
  ) {}

  async ping(clave: string): Promise<HealthIndicatorResult> {
    const indicador = this.indicators.check(clave);
    try {
      // `getJobCounts` en vez de un `PING` contra el cliente: es API pública y
      // estable de BullMQ, y comprueba algo más útil —que la COLA responde—, no
      // solo que quede un socket abierto contra Redis.
      const contadores = await this.queue.getJobCounts('waiting', 'failed');
      return indicador.up({
        waiting: contadores.waiting ?? 0,
        failed: contadores.failed ?? 0,
      });
    } catch (error) {
      return indicador.down({
        message: error instanceof Error ? error.message : 'sin detalle',
      });
    }
  }
}
