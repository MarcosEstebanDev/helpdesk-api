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

    it('la sugerencia de la IA va solo al equipo, sin el tono del cliente', async () => {
      const { sut, realtime } = montar();

      await sut.execute(
        evento('ticket.triaged', {
          category: 'bug',
          suggestedPriority: 'URGENT',
          sentiment: 'negative',
          language: 'es',
          model: 'qwen2.5:3b-instruct',
          promptVersion: 'triage-v2',
          ticketNumber: 336,
          ticketPriority: 'NORMAL',
        }),
      );

      expect(realtime.emisiones).toHaveLength(1);
      expect(realtime.emisiones[0].audience).toEqual({
        scope: 'staff',
        tenantId: TENANT,
      });
      // Lo justo para el aviso en vivo. El sentimiento que la IA le atribuye al
      // cliente NO viaja: quien lo necesite lo pide por HTTP, con permisos.
      expect(realtime.emisiones[0].message.payload).toEqual({
        ticketId: TICKET_ID,
        occurredAt: OCURRIO.toISOString(),
        category: 'bug',
        suggestedPriority: 'URGENT',
        number: 336,
        currentPriority: 'NORMAL',
      });
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

    it('pasar a la espera del cliente se difunde como cualquier cambio de estado', async () => {
      // El cliente tiene que ver que la pelota está de su lado, y el equipo que
      // el ticket volvió solo cuando el cliente contesta (ADR-0029).
      const { sut, realtime } = montar();

      await sut.execute(
        evento('ticket.status_changed', {
          from: 'IN_PROGRESS',
          to: 'WAITING_ON_CUSTOMER',
          assigneeId: 'un-agente',
        }),
      );

      expect(realtime.emisiones.map((e) => e.audience.scope).sort()).toEqual([
        'tenant',
        'ticket',
      ]);
      expect(realtime.emisiones[0].message.payload).toMatchObject({
        status: 'WAITING_ON_CUSTOMER',
      });
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

    describe('notas internas (ADR-0028)', () => {
      it('una nota interna se avisa solo a la sala del equipo', async () => {
        const { sut, realtime } = montar();

        await sut.execute(
          evento('comment.added', {
            commentId: 'c-1',
            authorId: 'agente',
            authorRole: 'AGENT',
            visibility: 'INTERNAL',
          }),
        );

        expect(realtime.emisiones.map((e) => e.audience.scope)).toEqual([
          'staff',
        ]);
      });

      it('una respuesta pública sigue yendo a la sala del ticket', async () => {
        const { sut, realtime } = montar();

        await sut.execute(
          evento('comment.added', {
            commentId: 'c-1',
            authorId: 'agente',
            authorRole: 'AGENT',
            visibility: 'PUBLIC',
          }),
        );

        expect(realtime.emisiones.map((e) => e.audience.scope)).toEqual([
          'ticket',
        ]);
      });

      it('un v2 (sin visibilidad) era público; un valor desconocido falla cerrado', async () => {
        const { sut, realtime } = montar();

        await sut.execute(
          evento('comment.added', { commentId: 'c-1', authorRole: 'AGENT' }),
        );
        await sut.execute(
          evento('comment.added', {
            commentId: 'c-2',
            authorRole: 'AGENT',
            visibility: 'PRIVADO',
          }),
        );

        expect(realtime.emisiones.map((e) => e.audience.scope)).toEqual([
          'ticket',
          'staff',
        ]);
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
