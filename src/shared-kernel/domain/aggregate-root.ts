import { Entity } from './entity';
import { DomainEvent } from './domain-event';

/**
 * An Aggregate Root is the only entry point to a cluster of objects that
 * change together. It records domain events; the infrastructure pulls them
 * after persistence to publish them (outbox pattern).
 */
export abstract class AggregateRoot<Id> extends Entity<Id> {
  private _domainEvents: DomainEvent[] = [];

  get domainEvents(): readonly DomainEvent[] {
    return this._domainEvents;
  }

  protected addDomainEvent(event: DomainEvent): void {
    this._domainEvents.push(event);
  }

  /** Returns and clears the pending events (called once, after persistence). */
  pullDomainEvents(): DomainEvent[] {
    const events = this._domainEvents;
    this._domainEvents = [];
    return events;
  }
}
