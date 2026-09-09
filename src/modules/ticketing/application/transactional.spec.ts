import { TransactionManager, err, ok } from '../../../shared-kernel';
import { runTransactional } from './transactional';

/**
 * Doble de {@link TransactionManager} que registra si la transacción habría
 * hecho COMMIT o ROLLBACK. Un motor real revierte cuando algo se lanza, así que
 * eso es exactamente lo que observa este doble.
 */
const fakeTransactions = (): {
  manager: TransactionManager;
  commits: number;
  rollbacks: number;
} => {
  const state = { commits: 0, rollbacks: 0 };
  const manager: TransactionManager = {
    run: async <T>(_tenantId: string, fn: () => Promise<T>): Promise<T> => {
      try {
        const result = await fn();
        state.commits += 1;
        return result;
      } catch (error) {
        state.rollbacks += 1;
        throw error;
      }
    },
  };
  return {
    manager,
    get commits() {
      return state.commits;
    },
    get rollbacks() {
      return state.rollbacks;
    },
  };
};

describe('runTransactional', () => {
  it('hace COMMIT y devuelve el valor cuando el caso de uso va bien', async () => {
    const tx = fakeTransactions();

    const result = await runTransactional(tx.manager, 'tenant-1', async () =>
      Promise.resolve(ok('listo')),
    );

    expect(result.isOk()).toBe(true);
    if (result.isOk()) expect(result.value).toBe('listo');
    expect(tx.commits).toBe(1);
    expect(tx.rollbacks).toBe(0);
  });

  it('hace ROLLBACK cuando el caso de uso devuelve un error de negocio', async () => {
    // Este es el motivo de existir del helper: un `Result` de error NO lanza, así
    // que sin él la transacción haría commit y dejaría a medias lo ya escrito
    // (por ejemplo, un número de ticket reservado).
    const tx = fakeTransactions();

    const result = await runTransactional(tx.manager, 'tenant-1', async () =>
      Promise.resolve(err(new Error('regla de negocio incumplida'))),
    );

    expect(result.isErr()).toBe(true);
    expect(tx.rollbacks).toBe(1);
    expect(tx.commits).toBe(0);
  });

  it('devuelve el MISMO error que produjo el caso de uso', async () => {
    const tx = fakeTransactions();
    const original = new Error('el asunto está vacío');

    const result = await runTransactional(tx.manager, 'tenant-1', async () =>
      Promise.resolve(err(original)),
    );

    // El rodeo por una excepción interna es un detalle de implementación: quien
    // llama recibe su error tal cual, no envuelto en otra cosa.
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error).toBe(original);
  });

  it('deja pasar las excepciones reales sin disfrazarlas de error de negocio', async () => {
    const tx = fakeTransactions();
    const caida = new Error('la base de datos no responde');

    await expect(
      runTransactional(tx.manager, 'tenant-1', () => Promise.reject(caida)),
    ).rejects.toBe(caida);

    expect(tx.rollbacks).toBe(1);
  });
});
