import { TenantId, TicketId, UserId } from '../ids';
import { Ticket } from './ticket.entity';

const TENANT = TenantId('11111111-1111-1111-1111-111111111111');
const REQUESTER = UserId('22222222-2222-2222-2222-222222222222');
const AGENTE = UserId('33333333-3333-3333-3333-333333333333');
const T0 = new Date('2026-09-09T10:00:00Z');
const T1 = new Date('2026-09-09T11:00:00Z');
const T2 = new Date('2026-09-09T12:00:00Z');

const abrir = (
  overrides: Partial<{ subject: string; description: string }> = {},
) =>
  Ticket.open({
    id: TicketId('44444444-4444-4444-4444-444444444444'),
    tenantId: TENANT,
    number: 1,
    subject: overrides.subject ?? 'No puedo entrar',
    description: overrides.description ?? 'Me da un error 500.',
    priority: 'NORMAL',
    requesterId: REQUESTER,
    now: T0,
  });

/** Atajo que da por hecho que el ticket se creó bien. */
const abrirOk = (): Ticket => {
  const result = abrir();
  if (result.isErr()) throw new Error('el ticket debería haberse creado');
  return result.value;
};

describe('Ticket', () => {
  describe('apertura', () => {
    it('nace OPEN, sin asignar y sin marcas del ciclo de vida', () => {
      const ticket = abrirOk();

      expect(ticket.status).toBe('OPEN');
      expect(ticket.assigneeId).toBeNull();
      expect(ticket.resolvedAt).toBeNull();
      expect(ticket.closedAt).toBeNull();
      expect(ticket.number).toBe(1);
      expect(ticket.requesterId).toBe(REQUESTER);
    });

    it('recorta los espacios del asunto y la descripción', () => {
      const result = abrir({ subject: '   Hola   ', description: '  Mundo  ' });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.subject).toBe('Hola');
        expect(result.value.description).toBe('Mundo');
      }
    });

    it('rechaza un asunto vacío o que solo tenga espacios', () => {
      const result = abrir({ subject: '    ' });

      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.code).toBe('ticketing.invalid_subject');
      }
    });

    it('rechaza una descripción vacía', () => {
      const result = abrir({ description: '' });

      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.code).toBe('ticketing.invalid_description');
      }
    });
  });

  describe('cambios de estado', () => {
    it('aplica una transición permitida y sella el instante', () => {
      const ticket = abrirOk();

      const result = ticket.changeStatus('IN_PROGRESS', T1);

      expect(result.isOk()).toBe(true);
      expect(ticket.status).toBe('IN_PROGRESS');
      expect(ticket.updatedAt).toBe(T1);
    });

    it('rechaza una transición ilegal sin tocar el ticket', () => {
      const ticket = abrirOk();

      const result = ticket.changeStatus('CLOSED', T1);

      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.code).toBe('ticketing.invalid_transition');
      }
      // Lo importante: el rechazo NO deja el ticket a medias.
      expect(ticket.status).toBe('OPEN');
      expect(ticket.updatedAt).toBe(T0);
    });

    it('pedir el estado actual es idempotente y no altera updatedAt', () => {
      const ticket = abrirOk();

      const result = ticket.changeStatus('OPEN', T1);

      expect(result.isOk()).toBe(true);
      expect(ticket.updatedAt).toBe(T0);
    });

    it('resolver sella resolvedAt', () => {
      const ticket = abrirOk();

      ticket.changeStatus('RESOLVED', T1);

      expect(ticket.resolvedAt).toBe(T1);
      expect(ticket.closedAt).toBeNull();
    });

    it('cerrar CONSERVA resolvedAt', () => {
      // El instante en que se resolvió es el dato que la fase 6 necesitará para
      // medir el SLA; cerrar no lo borra.
      const ticket = abrirOk();
      ticket.changeStatus('RESOLVED', T1);

      ticket.changeStatus('CLOSED', T2);

      expect(ticket.resolvedAt).toBe(T1);
      expect(ticket.closedAt).toBe(T2);
    });

    it('reabrir limpia las marcas del ciclo de vida', () => {
      const ticket = abrirOk();
      ticket.changeStatus('RESOLVED', T1);

      ticket.changeStatus('OPEN', T2);

      expect(ticket.status).toBe('OPEN');
      expect(ticket.resolvedAt).toBeNull();
      expect(ticket.closedAt).toBeNull();
    });

    it('un ticket cerrado no admite ningún cambio de estado', () => {
      const ticket = abrirOk();
      ticket.changeStatus('RESOLVED', T1);
      ticket.changeStatus('CLOSED', T2);

      for (const destino of ['OPEN', 'IN_PROGRESS', 'RESOLVED'] as const) {
        expect(ticket.changeStatus(destino, T2).isErr()).toBe(true);
      }
      expect(ticket.status).toBe('CLOSED');
    });
  });

  describe('asignación', () => {
    it('asigna y desasigna sin cambiar el estado', () => {
      const ticket = abrirOk();

      ticket.assignTo(AGENTE, T1);
      expect(ticket.assigneeId).toBe(AGENTE);
      // Tomar un ticket y empezar a trabajarlo son decisiones distintas.
      expect(ticket.status).toBe('OPEN');

      ticket.unassign(T2);
      expect(ticket.assigneeId).toBeNull();
    });

    it('no se puede asignar un ticket cerrado', () => {
      const ticket = abrirOk();
      ticket.changeStatus('RESOLVED', T1);
      ticket.changeStatus('CLOSED', T2);

      const result = ticket.assignTo(AGENTE, T2);

      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.code).toBe('ticketing.ticket_closed');
      }
      expect(ticket.assigneeId).toBeNull();
    });
  });

  describe('eventos de integración', () => {
    it('abrir un ticket registra ticket.created con su estado inicial', () => {
      const ticket = abrirOk();

      const eventos = ticket.pullDomainEvents();

      expect(eventos).toHaveLength(1);
      expect(eventos[0].eventName).toBe('ticket.created');
      expect(eventos[0].tenantId).toBe(TENANT);
      expect(eventos[0].aggregateId).toBe(ticket.id);
      expect(eventos[0].payload).toEqual({
        number: 1,
        subject: 'No puedo entrar',
        priority: 'NORMAL',
        status: 'OPEN',
        requesterId: REQUESTER,
      });
    });

    it('pullDomainEvents vacía la lista: no se publica dos veces', () => {
      const ticket = abrirOk();

      expect(ticket.pullDomainEvents()).toHaveLength(1);
      expect(ticket.pullDomainEvents()).toHaveLength(0);
    });

    it('el evento de cambio de estado lleva de dónde a dónde', () => {
      const ticket = abrirOk();
      ticket.pullDomainEvents(); // se descarta el de creación

      ticket.changeStatus('IN_PROGRESS', T1);

      const [evento] = ticket.pullDomainEvents();
      expect(evento.eventName).toBe('ticket.status_changed');
      expect(evento.payload).toEqual({
        from: 'OPEN',
        to: 'IN_PROGRESS',
        assigneeId: null,
      });
      expect(evento.occurredAt).toBe(T1);
    });

    it('una transición rechazada no registra nada', () => {
      const ticket = abrirOk();
      ticket.pullDomainEvents();

      ticket.changeStatus('CLOSED', T1);

      expect(ticket.pullDomainEvents()).toHaveLength(0);
    });

    it('pedir el estado actual tampoco registra nada', () => {
      const ticket = abrirOk();
      ticket.pullDomainEvents();

      ticket.changeStatus('OPEN', T1);

      expect(ticket.pullDomainEvents()).toHaveLength(0);
    });

    it('asignar y desasignar registran eventos distintos', () => {
      const ticket = abrirOk();
      ticket.pullDomainEvents();

      ticket.assignTo(AGENTE, T1);
      expect(ticket.pullDomainEvents()[0].eventName).toBe('ticket.assigned');

      ticket.unassign(T2);
      expect(ticket.pullDomainEvents()[0].eventName).toBe('ticket.unassigned');
    });

    it('rehidratar NO registra eventos', () => {
      // Cargar un ticket de la base de datos no es un hecho nuevo del dominio;
      // si emitiera eventos, cada lectura republicaría el pasado.
      const ticket = abrirOk();
      ticket.pullDomainEvents();

      const recargado = Ticket.rehydrate({
        id: ticket.id,
        tenantId: ticket.tenantId,
        number: ticket.number,
        subject: ticket.subject,
        description: ticket.description,
        status: ticket.status,
        priority: ticket.priority,
        requesterId: ticket.requesterId,
        assigneeId: ticket.assigneeId,
        createdAt: ticket.createdAt,
        updatedAt: ticket.updatedAt,
        resolvedAt: ticket.resolvedAt,
        closedAt: ticket.closedAt,
      });

      expect(recargado.pullDomainEvents()).toHaveLength(0);
    });
  });

  describe('comentarios', () => {
    it('los admite mientras no esté cerrado', () => {
      const ticket = abrirOk();
      expect(ticket.acceptsComments()).toBe(true);

      ticket.changeStatus('RESOLVED', T1);
      expect(ticket.acceptsComments()).toBe(true);

      ticket.changeStatus('CLOSED', T2);
      expect(ticket.acceptsComments()).toBe(false);
    });
  });
});
