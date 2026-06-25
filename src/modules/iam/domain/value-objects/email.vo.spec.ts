import { Email } from './email.vo';

describe('Email', () => {
  it('normaliza trim + lowercase', () => {
    const result = Email.create('  Marcos@Example.COM ');
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.value).toBe('marcos@example.com');
    }
  });

  it.each(['no-arroba', 'a@b', '@example.com', 'a@@b.com', 'a @b.com', ''])(
    'rechaza "%s"',
    (raw) => {
      const result = Email.create(raw);
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.code).toBe('iam.invalid_email');
      }
    },
  );

  it('dos emails con el mismo valor normalizado son iguales', () => {
    const a = Email.create('User@Test.com');
    const b = Email.create('user@test.com');
    expect(a.isOk() && b.isOk()).toBe(true);
    if (a.isOk() && b.isOk()) {
      expect(a.value.equals(b.value)).toBe(true);
    }
  });
});
