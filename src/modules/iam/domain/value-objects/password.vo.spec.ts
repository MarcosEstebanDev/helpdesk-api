import { Password } from './password.vo';

describe('Password', () => {
  it('acepta un password que cumple la política', () => {
    const result = Password.create('super-secreta');
    expect(result.isOk()).toBe(true);
  });

  it('rechaza passwords demasiado cortos', () => {
    const result = Password.create('1234567');
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe('iam.weak_password');
    }
  });

  it('rechaza passwords desmesuradamente largos (anti-DoS)', () => {
    const result = Password.create('a'.repeat(Password.MAX_LENGTH + 1));
    expect(result.isErr()).toBe(true);
  });
});
