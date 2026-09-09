import type {
  RealtimeAudience,
  RealtimeMessage,
  RealtimePublisher,
} from '../../../../shared-kernel';

export interface BroadcastInput {
  eventName: string;
  version: number;
  tenantId: string;
  /** Id del ticket: todos los eventos de este contexto cuelgan del ticket. */
  ticketId: string;
  occurredAt: Date;
  payload: Record<string, unknown>;
}

export type BroadcastOutcome =
  | { action: 'broadcast'; audiences: number }
  | { action: 'ignored'; detail: string };

/** Un envío ya resuelto: a quién y con qué. */
interface Delivery {
  audience: RealtimeAudience;
  message: RealtimeMessage;
}

/**
 * Traduce un evento de integración en los mensajes que ven los clientes
 * (ADR-0023).
 *
 * Vive en `application` y no en el gateway a propósito: **qué ve cada quien es
 * una regla de negocio**, no un detalle de transporte. El gateway sabe mandar a
 * una room; decidir que el incumplimiento de un SLA es asunto del equipo y no
 * del cliente que reclama es una decisión de producto, y tiene que poder
 * probarse sin levantar un socket.
 *
 * Dos reglas transversales:
 *
 * 1. **Nunca se reenvía el evento de integración tal cual.** Es "gordo" a
 *    propósito (ADR-0018) y lleva campos internos; el contrato del WebSocket se
 *    versiona por motivos distintos que el del outbox y no debe heredar sus
 *    cambios sin querer.
 * 2. **Nada de identificadores de personas hacia la sala general.** Al ticket y
 *    al tenant va lo justo para refrescar una lista; los datos de quién atiende
 *    a quién se quedan en la sala del equipo.
 */
export class BroadcastTicketEvent {
  constructor(private readonly realtime: RealtimePublisher) {}

  async execute(input: BroadcastInput): Promise<BroadcastOutcome> {
    const deliveries = this.deliveriesFor(input);
    if (deliveries.length === 0) {
      return {
        action: 'ignored',
        detail: `evento sin vista: ${input.eventName}`,
      };
    }

    for (const delivery of deliveries) {
      await this.realtime.publish(delivery.audience, delivery.message);
    }
    return { action: 'broadcast', audiences: deliveries.length };
  }

  private deliveriesFor(input: BroadcastInput): Delivery[] {
    const { tenantId, ticketId } = input;
    const tenant: RealtimeAudience = { scope: 'tenant', tenantId };
    const staff: RealtimeAudience = { scope: 'staff', tenantId };
    const ticket: RealtimeAudience = { scope: 'ticket', tenantId, ticketId };

    const base = { ticketId, occurredAt: input.occurredAt.toISOString() };

    switch (input.eventName) {
      case 'ticket.created':
        return [
          {
            audience: tenant,
            message: {
              event: 'ticket.created',
              payload: {
                ...base,
                number: input.payload.number,
                subject: input.payload.subject,
                priority: input.payload.priority,
                status: input.payload.status,
              },
            },
          },
        ];

      case 'ticket.status_changed':
        // A la sala del ticket y a la general: el estado es justo lo que hace
        // que una lista abierta en otra pestaña deje de ser cierta.
        return [tenant, ticket].map((audience) => ({
          audience,
          message: {
            event: 'ticket.status_changed',
            payload: { ...base, status: input.payload.to },
          },
        }));

      case 'comment.added':
        return [
          {
            audience: ticket,
            message: {
              event: 'comment.added',
              // Va el id, no el cuerpo: el mensaje llega a todo el que tenga el
              // ticket abierto, y el cliente lo recarga con SUS permisos. Así
              // este camino no puede convertirse nunca en una fuga de contenido.
              payload: { ...base, commentId: input.payload.commentId },
            },
          },
        ];

      case 'ticket.assigned':
      case 'ticket.unassigned':
        // Solo al equipo: a quién le toca cada ticket es organización interna.
        return [
          {
            audience: staff,
            message: {
              event: input.eventName,
              payload: {
                ...base,
                assigneeId: input.payload.assigneeId ?? null,
                status: input.payload.status,
              },
            },
          },
        ];

      case 'sla.breached':
        // Al equipo, y solo al equipo. Avisar al solicitante de que se ha
        // incumplido el compromiso con él es una decisión de producto —y
        // probablemente un email, no un aviso en pantalla—, no algo que deba
        // pasar por omisión.
        return [
          {
            audience: staff,
            message: {
              event: 'sla.breached',
              payload: {
                ...base,
                kind: input.payload.kind,
                dueAt: input.payload.dueAt,
                priority: input.payload.priority,
                assigneeId: input.payload.assigneeId ?? null,
              },
            },
          },
        ];

      default:
        return [];
    }
  }
}
