/**
 * Puerto de generación de ids (UUID v4 en 2c). Inyectarlo —en vez de llamar a
 * crypto.randomUUID directo— mantiene los casos de uso deterministas en los tests.
 */
export interface IdGenerator {
  uuid(): string;
}

export const ID_GENERATOR = Symbol('iam.IdGenerator');
