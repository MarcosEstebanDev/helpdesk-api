import { TENANT, fakeRealtimePublisher } from '../ticketing.test-doubles';
import {
  BroadcastInput,
  BroadcastTicketEvent,
} from './broadcast-ticket-event.use-case';

const TICKET_ID = '44444444-4444-4444-4444-444444444444';
const OCURRIO = new Date('2026-09-09T10:00:00.000Z');

const montar = () => {
  const realtime = fakeRealtimePublisher();
  return { realtime, sut: new BroadcastTicketEvent(realtime) };
};

const evento = (
  eventName: string,
  payload: Record<string, unknown> = {},
): BroadcastInput => ({
  eventName,
  version: 1,
  tenantId: TENANT,
  ticketId: TICKET_ID,
  occurredAt: OCURRIO,
  payload,
});

describe('BroadcastTicketEvent', () => {
  describe('quién recibe cada cosa', () => {
    it('un ticket nuevo se anuncia a toda la organización', async () => {
      const { sut, realtime } = montar();

      await sut.execute(
        evento('ticket.created', {
          number: 7,
          subject: 'No puedo entrar',
          priority: 'HIGH',
          status: 'OPEN',
          requesterId: 'quien-lo-abrio',
        }),
      );

      expect(realtime.emisiones).toHaveLength(1);
      expect(realtime.emisiones[0].audience).toEqual({
        scope: 'tenant',
        tenantId: TENANT,
      });
      expect(realtime.emisiones[0].message.payload).toEqual({
        ticketId: TICKET_ID,
        occurredAt: OCURRIO.toISOString(),
        number: 7,
        subject: 'No puedo entrar',
        priority: 'HIGH',
        status: 'OPEN',
      });
    });

    it('el incumplimiento de un SLA es asunto del equipo, no del cliente', async () => {
      // El test que justifica que exista la sala de staff: el solicitante NO se
      // entera por aquí de que se ha incumplido el compromiso con él. Avisarle
      // es una decisión de producto, no algo que deba pasar por omisión.
      const { sut, realtime } = montar();

      await sut.execute(
        evento('sla.breached', {
          timerId: 'reloj',
          kind: 'RESPONSE',
          dueAt: OCURRIO.toISOString(),
          assigneeId: 'un-agente',
          priority: 'URGENT',
        }),
      );

      expect(realtime.para('staff')).toHaveLength(1);
      expect(realtime.para('tenant')).toHaveLength(0);
      expect(realtime.para('ticket')).toHaveLength(0);
    });

    it('a quién le toca un ticket solo lo ve el equipo', async () => {
      const { sut, realtime } = montar();

      await sut.execute(
        evento('ticket.assigned', {
          assigneeId: 'un-agente',
          status: 'OPEN',
        }),
      );

      expect(realtime.para('staff')).toHaveLength(1);
      expect(realtime.para('tenant')).toHaveLength(0);
    });

    it('un cambio de estado va a la lista y al detalle abierto', async () => {
      const { sut, realtime } = montar();

      await sut.execute(
        evento('ticket.status_changed', {
          from: 'OPEN',
          to: 'IN_PROGRESS',
          assigneeId: 'un-agente',
        }),
      );

      expect(realtime.emisiones.map((e) => e.audience.scope).sort()).toEqual([
        'tenant',
        'ticket',
      ]);
    });
  });

  describe('qué viaja por el cable', () => {
    it('un comentario avisa con su id, nunca con su contenido', async () => {
      // El mensaje llega a todo el que tenga el ticket abierto; que el cliente
      // lo recargue con SUS permisos hace imposible que este camino se convierta
      // en una fuga de contenido.
      const { sut, realtime } = montar();

      await sut.execute(
        evento('comment.added', {
          commentId: 'c-1',
          authorId: 'quien-sea',
          authorRole: 'ADMIN',
          body: 'texto que no debe salir',
        }),
      );

      const payload = realtime.emisiones[0].message.payload;
      expect(payload).toEqual({
        ticketId: TICKET_ID,
        occurredAt: OCURRIO.toISOString(),
        commentId: 'c-1',
      });
    });

    it('no reenvía el evento de integración entero', async () => {
      // El evento es "gordo" a propósito (ADR-0018). Si se reenviara tal cual,
      // cualquier campo nuevo del outbox acabaría publicado sin querer.
      const { sut, realtime } = montar();

      await sut.execute(
        evento('ticket.created', {
          number: 7,
          subject: 'Asunto',
          priority: 'LOW',
          status: 'OPEN',
          requesterId: 'no-debe-viajar',
          campoInterno: 'tampoco',
        }),
      );

      const payload = realtime.emisiones[0].message.payload;
      expect(payload).not.toHaveProperty('requesterId');
      expect(payload).not.toHaveProperty('campoInterno');
    });
  });

  describe('eventos sin vista', () => {
    it('se ignoran en vez de emitirse a medias', async () => {
      const { sut, realtime } = montar();

      const resultado = await sut.execute(evento('ticket.archivado'));

      expect(resultado).toEqual({
        action: 'ignored',
        detail: 'evento sin vista: ticket.archivado',
      });
      expect(realtime.emisiones).toHaveLength(0);
    });
  });
});
