/**
 * Puerto de tiempo. Inyectarlo hace testeable la expiración de tokens y los
 * timestamps de las entidades sin depender del reloj real.
 */
export interface Clock {
  now(): Date;
}

export const CLOCK = Symbol('iam.Clock');
