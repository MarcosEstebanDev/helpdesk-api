/**
 * Puerto de unidad de trabajo: ejecuta varias operaciones de repositorio dentro
 * de UNA sola transacción de base de datos (ADR-0016).
 *
 * Existe porque hay invariantes que cruzan repositorios. El caso testigo es el
 * de la fase 4: guardar un ticket y su registro de auditoría. Si cada repo abre
 * su propia transacción, existe un instante en el que el ticket está guardado y
 * su auditoría no; un fallo justo ahí deja el rastro incompleto para siempre.
 *
 * Es además el ensayo del transactional outbox (ADR-0007): en la fase 5, el
 * evento se escribirá en la tabla de outbox dentro de esta misma transacción.
 *
 * `tenantId` es explícito y `string` (no un id branded) a propósito: el
 * shared-kernel no puede conocer los tipos de ningún bounded context, y todo id
 * branded es asignable a `string`, así que no se pierde seguridad en el llamador.
 */
export interface TransactionManager {
  run<T>(tenantId: string, fn: () => Promise<T>): Promise<T>;
}

export const TRANSACTION_MANAGER = Symbol('shared.TransactionManager');
