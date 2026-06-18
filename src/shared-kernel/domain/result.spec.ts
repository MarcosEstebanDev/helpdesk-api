import { ok, err } from './result';

describe('Result', () => {
  it('ok() carries a value and narrows via isOk()', () => {
    const result = ok(42);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toBe(42);
    }
  });

  it('err() carries an error and narrows via isErr()', () => {
    const result = err(new Error('boom'));
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.message).toBe('boom');
    }
  });
});
