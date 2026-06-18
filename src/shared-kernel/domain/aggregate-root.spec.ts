import { AggregateRoot } from './aggregate-root';
import { DomainEvent } from './domain-event';

class SampleCreated implements DomainEvent {
  readonly eventName = 'sample.created';
  readonly occurredAt = new Date();
  constructor(public readonly aggregateId: string) {}
}

class Sample extends AggregateRoot<string> {
  static create(id: string): Sample {
    const sample = new Sample(id);
    sample.addDomainEvent(new SampleCreated(id));
    return sample;
  }
}

describe('AggregateRoot', () => {
  it('records domain events', () => {
    const sample = Sample.create('a');
    expect(sample.domainEvents).toHaveLength(1);
  });

  it('pulls events once, then is empty', () => {
    const sample = Sample.create('a');
    const pulled = sample.pullDomainEvents();
    expect(pulled).toHaveLength(1);
    expect(sample.domainEvents).toHaveLength(0);
  });
});
