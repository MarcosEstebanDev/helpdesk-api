import { Result, TransactionManager, err } from '../../../shared-kernel';

/**
 * Señal interna para abortar una transacción. Nunca sale de este fichero.
 */
class RollbackSignal extends Error {
  constructor(readonly reason: unknown) {
    super('rollback');
  }
}

/**
 * Ejecuta un caso de uso que devuelve `Result` dentro de una transacción,
 * haciendo ROLLBACK cuando el resultado es un error.
 *
 * Existe por un choque real entre dos decisiones del proyecto. Con ADR-0005 los
 * errores de negocio son VALORES, no excepciones; pero una transacción solo
 * revierte si algo se lanza. Si un caso de uso reserva el número de ticket
 * (ADR-0017) y después devuelve `err` por una validación, la transacción haría
 * COMMIT: el número quedaría consumido por un ticket que nunca existió, y la
 * numeración tendría un hueco.
 *
 * Así que el `Err` se convierte en excepción justo el tiempo necesario para que
 * el motor revierta, y vuelve a ser `Result` al salir. Los casos de uso siguen
 * escribiéndose con `Result` de principio a fin; el truco vive aquí y en ningún
 * otro sitio.
 */
export const runTransactional = async <T, E>(
  transactions: TransactionManager,
  tenantId: string,
  fn: () => Promise<Result<T, E>>,
): Promise<Result<T, E>> => {
  try {
    return await transactions.run(tenantId, async () => {
      const result = await fn();
      if (result.isErr()) {
        throw new RollbackSignal(result.error);
      }
      return result;
    });
  } catch (error) {
    if (error instanceof RollbackSignal) {
      // El cast es seguro: `reason` solo lo pone la rama de arriba, con el
      // error del propio `Result<T, E>` que se acaba de comprobar.
      return err(error.reason as E);
    }
    // Cualquier otra excepción es un fallo real (la BD caída, un bug): se
    // propaga para que la maneje el borde HTTP, no se disfraza de error de negocio.
    throw error;
  }
};
