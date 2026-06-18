/**
 * A domain event records something meaningful that happened in the domain.
 * Aggregates raise events; the application layer publishes them (later via a
 * transactional outbox — ADR-0007) so consumers (BullMQ jobs, the WebSocket
 * gateway) react asynchronously.
 */
export interface DomainEvent {
  /** Stable, versioned name, e.g. "ticket.created". */
  readonly eventName: string;
  readonly occurredAt: Date;
  /** Id of the aggregate that raised the event. */
  readonly aggregateId: string;
}
