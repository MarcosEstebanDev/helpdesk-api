import { ValueObject } from './value-object';

class Money extends ValueObject<{ amount: number; currency: string }> {
  static of(amount: number, currency: string): Money {
    return new Money({ amount, currency });
  }
}

describe('ValueObject', () => {
  it('is equal by structural value', () => {
    expect(Money.of(100, 'USD').equals(Money.of(100, 'USD'))).toBe(true);
  });

  it('differs when any prop differs', () => {
    expect(Money.of(100, 'USD').equals(Money.of(100, 'ARS'))).toBe(false);
  });

  it('is not equal to null/undefined', () => {
    expect(Money.of(1, 'USD').equals(undefined)).toBe(false);
  });
});
