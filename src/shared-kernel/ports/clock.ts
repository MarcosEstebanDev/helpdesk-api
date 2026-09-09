/**
 * Puerto de tiempo. Inyectarlo —en vez de llamar a `new Date()`— hace
 * deterministas los tests de expiración de tokens, de SLA y de timestamps.
 *
 * Vive en el shared-kernel y no en un bounded context concreto: el tiempo no es
 * un concepto de identidad ni de ticketing, y que `ticketing` tuviera que
 * importarlo desde `iam` acoplaría dos contextos que no comparten dominio.
 */
export interface Clock {
  now(): Date;
}

export const CLOCK = Symbol('shared.Clock');
