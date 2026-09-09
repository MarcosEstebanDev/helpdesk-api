import { Entity } from './entity';
import { DomainEvent } from './domain-event';

/**
 * An Aggregate Root is the only entry point to a cluster of objects that
 * change together. It records domain events; the infrastructure pulls them
 * after persistence to publish them (outbox pattern, ADR-0007).
 *
 * El segundo parámetro de tipo estrecha QUÉ eventos puede emitir este agregado.
 * Con el valor por defecto (`DomainEvent`) todo sigue como antes, pero un
 * agregado que lo concreta —`AggregateRoot<TicketId, TicketingEvent>`— hace que
 * `pullDomainEvents()` devuelva ya el tipo bueno: quien los publica no necesita
 * un cast, y añadir un evento sin declararlo en la unión no compila.
 */
export abstract class AggregateRoot<
  Id,
  E extends DomainEvent = DomainEvent,
> extends Entity<Id> {
  private _domainEvents: E[] = [];

  get domainEvents(): readonly E[] {
    return this._domainEvents;
  }

  protected addDomainEvent(event: E): void {
    this._domainEvents.push(event);
  }

  /** Returns and clears the pending events (called once, after persistence). */
  pullDomainEvents(): E[] {
    const events = this._domainEvents;
    this._domainEvents = [];
    return events;
  }
}
