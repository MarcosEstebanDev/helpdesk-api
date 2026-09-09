/**
 * Puerto de generación de ids (UUID v4). Inyectarlo mantiene los casos de uso
 * deterministas en los tests. Ver {@link Clock} para el porqué de su ubicación.
 */
export interface IdGenerator {
  uuid(): string;
}

export const ID_GENERATOR = Symbol('shared.IdGenerator');
