import { Logger } from '@nestjs/common';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import {
  AccessTokenVerifier,
  type AuthPrincipal,
} from '../../modules/iam/infrastructure/auth/access-token.verifier';
import { hasAtLeastRole } from '../../modules/iam/domain/role';
import type {
  RealtimeAudience,
  RealtimeMessage,
  RealtimePublisher,
} from '../../shared-kernel';

/**
 * Motivos de cierre. Van como `reason` en el evento `disconnected` que se manda
 * ANTES de cerrar, para que el cliente sepa si debe refrescar el token y
 * reconectar o si es que no tiene nada que hacer aquí.
 */
export const CLOSE_UNAUTHORIZED = 'unauthorized';
export const CLOSE_TOKEN_EXPIRED = 'token_expired';

/** Lo que el gateway recuerda de cada socket una vez autenticado. */
interface SocketState {
  principal: AuthPrincipal;
  /** Temporizador que cierra el socket cuando caduca su token. */
  expiry: NodeJS.Timeout;
}

/**
 * Traduce una audiencia de negocio al nombre de room de Socket.io.
 *
 * Es una función y no plantillas repartidas por el código porque el prefijo de
 * tenant es lo único que separa a dos organizaciones dentro del mismo proceso:
 * escribirlo a mano en varios sitios es pedir que un día falte.
 */
export const roomOf = (audience: RealtimeAudience): string => {
  switch (audience.scope) {
    case 'tenant':
      return `tenant:${audience.tenantId}`;
    case 'staff':
      return `tenant:${audience.tenantId}:staff`;
    case 'ticket':
      return `tenant:${audience.tenantId}:ticket:${audience.ticketId}`;
  }
};

/**
 * Gateway de tiempo real (ADR-0022).
 *
 * **El `tenantId` sale siempre del token verificado, nunca de lo que manda el
 * cliente.** Es la misma regla que en HTTP, y aquí es más importante todavía:
 * fuera del ciclo request/response no hay middleware de contexto ni RLS
 * cubriendo las espaldas — lo único que separa a dos organizaciones es en qué
 * room acabó cada socket.
 *
 * Por eso quien decide las rooms es el servidor al conectar. Un cliente puede
 * pedir que le sigan un ticket, pero el room al que entra se construye con SU
 * tenant: pedir el ticket de otra organización mete al socket en una room que no
 * existe, en vez de en la del vecino.
 */
@WebSocketGateway({ cors: { origin: true, credentials: true } })
export class RealtimeGateway
  implements OnGatewayConnection, OnGatewayDisconnect, RealtimePublisher
{
  private readonly logger = new Logger(RealtimeGateway.name);
  private readonly sockets = new Map<string, SocketState>();

  @WebSocketServer()
  private readonly server!: Server;

  constructor(private readonly tokens: AccessTokenVerifier) {}

  // ------------------------------------------------------ ciclo de vida

  async handleConnection(client: Socket): Promise<void> {
    const token = tokenFrom(client);
    const principal = token === null ? null : await this.tokens.verify(token);

    if (principal === null) {
      this.close(client, CLOSE_UNAUTHORIZED);
      return;
    }

    await client.join(
      roomOf({ scope: 'tenant', tenantId: principal.tenantId }),
    );
    // El filtrado por rol se resuelve AL ENTRAR, no en cada emisión: un olvido
    // al emitir filtraría datos, mientras que un socket que nunca entró en la
    // room de staff no puede recibir lo que se manda ahí por mucho que se falle
    // más adelante.
    if (hasAtLeastRole(principal.role, 'AGENT')) {
      await client.join(
        roomOf({ scope: 'staff', tenantId: principal.tenantId }),
      );
    }

    this.sockets.set(client.id, {
      principal,
      expiry: this.scheduleExpiry(client, token as string),
    });
  }

  handleDisconnect(client: Socket): void {
    const state = this.sockets.get(client.id);
    if (state !== undefined) {
      clearTimeout(state.expiry);
      this.sockets.delete(client.id);
    }
  }

  // ---------------------------------------------------------- mensajes

  /**
   * Sigue un ticket concreto (el usuario abrió su detalle).
   *
   * No se comprueba que el ticket exista ni que sea suyo: el room lleva SU
   * tenant, así que seguir un id ajeno no da acceso a nada, solo a una room
   * vacía. Consultar la base de datos en cada suscripción sería un coste real a
   * cambio de una garantía que la construcción del nombre ya da.
   */
  @SubscribeMessage('ticket:watch')
  async watchTicket(
    client: Socket,
    ticketId: unknown,
  ): Promise<{ watching: string } | { error: string }> {
    const state = this.sockets.get(client.id);
    if (state === undefined) return { error: CLOSE_UNAUTHORIZED };
    if (typeof ticketId !== 'string' || ticketId === '') {
      return { error: 'ticket_id_invalido' };
    }

    await client.join(
      roomOf({
        scope: 'ticket',
        tenantId: state.principal.tenantId,
        ticketId,
      }),
    );
    return { watching: ticketId };
  }

  @SubscribeMessage('ticket:unwatch')
  async unwatchTicket(client: Socket, ticketId: unknown): Promise<void> {
    const state = this.sockets.get(client.id);
    if (state === undefined || typeof ticketId !== 'string') return;

    await client.leave(
      roomOf({
        scope: 'ticket',
        tenantId: state.principal.tenantId,
        ticketId,
      }),
    );
  }

  // --------------------------------------------------- RealtimePublisher

  publish(audience: RealtimeAudience, message: RealtimeMessage): Promise<void> {
    this.server.to(roomOf(audience)).emit(message.event, message.payload);
    return Promise.resolve();
  }

  // --------------------------------------------------------- utilidades

  /**
   * Cierra el socket cuando expira el token con el que se conectó.
   *
   * Sin esto, una conexión abierta sobreviviría indefinidamente a su credencial:
   * quien fue despedido esta mañana seguiría recibiendo los tickets de la tarde
   * mientras no cerrara la pestaña. Se avisa antes de cerrar para que el cliente
   * distinga "refresca y vuelve" de "no tienes acceso".
   */
  private scheduleExpiry(client: Socket, token: string): NodeJS.Timeout {
    const expiraEn = expiryMillis(token);
    return setTimeout(() => {
      this.close(client, CLOSE_TOKEN_EXPIRED);
    }, expiraEn).unref();
  }

  private close(client: Socket, reason: string): void {
    client.emit('disconnected', { reason });
    client.disconnect(true);
    this.logger.debug(`socket ${client.id} cerrado: ${reason}`);
  }
}

/**
 * El token viaja en `auth.token` del handshake, no en la query string: las URLs
 * acaban en logs de proxies y en el historial del navegador, y un access token
 * en un log es un access token filtrado.
 */
const tokenFrom = (client: Socket): string | null => {
  const raw: unknown = client.handshake.auth?.token;
  return typeof raw === 'string' && raw !== '' ? raw : null;
};

/** Milisegundos que le quedan al token, mirando su `exp`. */
const expiryMillis = (token: string): number => {
  try {
    const claims = JSON.parse(
      Buffer.from(token.split('.')[1], 'base64url').toString('utf8'),
    ) as { exp?: number };
    if (typeof claims.exp !== 'number') return 0;
    return Math.max(0, claims.exp * 1000 - Date.now());
    // El token ya se verificó con su firma antes de llegar aquí; esto solo lee
    // un campo del payload para saber cuándo programar el cierre.
  } catch {
    return 0;
  }
};
