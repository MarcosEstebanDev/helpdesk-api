import { INestApplication, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { Redis } from 'ioredis';
import type { Server, ServerOptions } from 'socket.io';
import type { Env } from '../config/env.schema';

/**
 * Adapter de Socket.io respaldado por Redis (ADR-0022).
 *
 * Sin esto, `server.to(room).emit(...)` solo alcanza a los sockets conectados a
 * ESTE proceso. Con dos réplicas detrás de un balanceador —que es el despliegue
 * que el proyecto asume desde el ADR-0019, cuando separó workers de API— la
 * mitad de los usuarios se perdería la mitad de los mensajes, de forma
 * intermitente y sin ningún error en los logs. Es de los fallos más difíciles de
 * diagnosticar en producción y de los más baratos de evitar aquí: Redis ya está
 * en el stack por BullMQ.
 *
 * Se usan DOS conexiones porque un cliente de Redis en modo suscripción no puede
 * ejecutar otros comandos; `duplicate()` copia la configuración de la primera.
 */
export class RedisIoAdapter extends IoAdapter {
  private readonly logger = new Logger(RedisIoAdapter.name);
  private adapterConstructor?: ReturnType<typeof createAdapter>;
  private clients: Redis[] = [];

  async connect(url: string): Promise<void> {
    const pub = new Redis(url);
    const sub = pub.duplicate();
    this.clients = [pub, sub];
    await Promise.all([pub.connect?.(), sub.connect?.()].map(ignoreReady));
    this.adapterConstructor = createAdapter(pub, sub);
    this.logger.log('Socket.io usando el adapter de Redis');
  }

  /**
   * Cierra también las dos conexiones a Redis.
   *
   * Nest cierra el servidor de Socket.io, pero estos clientes se crearon fuera
   * del contenedor, así que nadie más los conoce. Sin esto el proceso NO
   * TERMINA: quedan dos sockets abiertos y el bucle de eventos de Node sigue
   * teniendo trabajo. En los tests se manifiesta como un "Jest did not exit"; en
   * un despliegue, como un contenedor que ignora el SIGTERM hasta que lo matan.
   */
  async close(server: Server): Promise<void> {
    await super.close(server);
    await Promise.all(
      this.clients.map((client) =>
        client.quit().catch(() => client.disconnect()),
      ),
    );
    this.clients = [];
  }

  createIOServer(port: number, options?: ServerOptions): unknown {
    // `super.createIOServer` está tipado como `any`; se acota aquí para que el
    // `any` no se propague al resto del fichero.
    const server = super.createIOServer(port, options) as {
      adapter: (factory: ReturnType<typeof createAdapter>) => void;
    };
    if (this.adapterConstructor !== undefined) {
      server.adapter(this.adapterConstructor);
    }
    return server;
  }
}

/**
 * ioredis conecta solo al construirse (`lazyConnect` desactivado), así que
 * llamar a `connect()` puede rechazar con "already connecting/connected". Eso no
 * es un fallo: significa que ya está hecho.
 */
const ignoreReady = (p: Promise<unknown> | undefined): Promise<unknown> =>
  (p ?? Promise.resolve()).catch(() => undefined);

/**
 * Engancha el adapter a la aplicación. Se llama aparte de `configureApp` porque
 * es asíncrono y porque solo lo necesita quien vaya a levantar sockets: los e2e
 * que no tocan tiempo real no pagan una conexión más a Redis.
 */
export const attachRealtimeAdapter = async (
  app: INestApplication,
): Promise<void> => {
  const config = app.get(ConfigService<Env, true>);
  const adapter = new RedisIoAdapter(app);
  await adapter.connect(config.get('REDIS_URL', { infer: true }));
  app.useWebSocketAdapter(adapter);
};
