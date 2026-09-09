import { IdGenerator, OutboxWriter } from '../../../shared-kernel';
import { TicketingEvent } from '../domain/events/ticketing.events';

/** Lo mínimo que necesita el grabador: un agregado del que sacar sus eventos. */
interface EventSource {
  pullDomainEvents(): TicketingEvent[];
}

/**
 * Vuelca al outbox los eventos que el agregado ha ido registrando (ADR-0018).
 *
 * Como {@link AuditRecorder}, NO abre transacción propia: se apoya en la que ya
 * abrió el caso de uso. Ahí está toda la garantía del patrón — si el cambio se
 * guarda, sus eventos existen; si algo falla, no queda ni una cosa ni la otra.
 * Publicar sobre una cola desde dentro del caso de uso, en cambio, dejaría un
 * mensaje anunciando algo que la transacción luego revirtió.
 *
 * `pullDomainEvents` VACÍA la lista: llamarlo dos veces sobre el mismo agregado
 * no duplica mensajes.
 */
export class EventRecorder {
  constructor(
    private readonly ids: IdGenerator,
    private readonly outbox: OutboxWriter,
  ) {}

  async record(aggregate: EventSource): Promise<void> {
    const events = aggregate.pullDomainEvents();
    if (events.length === 0) {
      return;
    }

    await this.outbox.append(
      events.map((event) => ({ id: this.ids.uuid(), ...event })),
    );
  }
}
