import { Result, err, ok } from '../../../../shared-kernel';
import { InvalidSlaTargetError } from '../errors';
import { TICKET_PRIORITIES, TicketPriority } from '../ticket-status';

/**
 * Objetivos de SLA por prioridad (ADR-0020).
 *
 * Dos relojes independientes por ticket:
 * - **Respuesta**: cuánto puede tardar la organización en contestarle al cliente.
 * - **Resolución**: cuánto puede tardar en dejarlo arreglado.
 *
 * Se miden por separado porque incumplen por motivos distintos: responder rápido
 * y tardar en resolver es un problema de capacidad; tardar en responder es un
 * problema de atención, y el cliente lo nota mucho antes.
 */
export interface SlaTarget {
  responseMinutes: number;
  resolutionMinutes: number;
}

export type SlaPolicy = Readonly<Record<TicketPriority, SlaTarget>>;

/**
 * Política por defecto, en el DOMINIO y no en una migración de datos.
 *
 * Una organización que no ha configurado nada tiene igualmente un SLA: si el
 * valor por defecto viviera en una fila sembrada al registrarse, el módulo `iam`
 * tendría que saber de SLA —acoplando dos bounded contexts— y cualquier tenant
 * creado antes de esta fase se quedaría sin política.
 */
export const DEFAULT_SLA_POLICY: SlaPolicy = {
  URGENT: { responseMinutes: 15, resolutionMinutes: 4 * 60 },
  HIGH: { responseMinutes: 60, resolutionMinutes: 8 * 60 },
  NORMAL: { responseMinutes: 4 * 60, resolutionMinutes: 24 * 60 },
  LOW: { responseMinutes: 8 * 60, resolutionMinutes: 72 * 60 },
};

/**
 * Combina lo que el tenant haya configurado con los valores por defecto.
 *
 * El merge es POR PRIORIDAD: una organización puede endurecer solo `URGENT` y
 * quedarse con el resto por defecto, sin tener que declarar las cuatro.
 */
export const resolvePolicy = (
  overrides: Partial<Record<TicketPriority, SlaTarget>>,
): SlaPolicy => ({
  URGENT: overrides.URGENT ?? DEFAULT_SLA_POLICY.URGENT,
  HIGH: overrides.HIGH ?? DEFAULT_SLA_POLICY.HIGH,
  NORMAL: overrides.NORMAL ?? DEFAULT_SLA_POLICY.NORMAL,
  LOW: overrides.LOW ?? DEFAULT_SLA_POLICY.LOW,
});

/**
 * Techo de un objetivo de SLA: un año.
 *
 * No es una restricción técnica, es una de sentido: un plazo de varios años no
 * es un compromiso, es la ausencia de uno, y deja relojes corriendo para siempre
 * que el barrido tiene que mirar en cada pasada. Quien no quiera comprometerse a
 * nada, que no configure la prioridad.
 */
export const SLA_MAX_MINUTES = 365 * 24 * 60;

const esPlazoValido = (minutos: number): boolean =>
  Number.isInteger(minutos) && minutos >= 1 && minutos <= SLA_MAX_MINUTES;

/**
 * Constructor validado de un objetivo. Es la única forma de fabricar un
 * `SlaTarget` que venga de fuera: `DEFAULT_SLA_POLICY` está en el código y ya se
 * revisó al escribirlo, pero lo que teclea un administrador pasa por aquí.
 *
 * La regla que no puede vivir en el DTO es la última: los dos relojes son
 * independientes, así que "resolver en 30 minutos y responder en 4 horas" se
 * ejecutaría tan campante y nadie se enteraría hasta ver los incumplimientos.
 */
export const makeSlaTarget = (input: {
  responseMinutes: number;
  resolutionMinutes: number;
}): Result<SlaTarget, InvalidSlaTargetError> => {
  if (!esPlazoValido(input.responseMinutes)) {
    return err(
      new InvalidSlaTargetError(
        `El plazo de respuesta debe ser un número entero de minutos entre 1 y ${SLA_MAX_MINUTES}.`,
      ),
    );
  }
  if (!esPlazoValido(input.resolutionMinutes)) {
    return err(
      new InvalidSlaTargetError(
        `El plazo de resolución debe ser un número entero de minutos entre 1 y ${SLA_MAX_MINUTES}.`,
      ),
    );
  }
  if (input.resolutionMinutes < input.responseMinutes) {
    return err(
      new InvalidSlaTargetError(
        'El plazo de resolución no puede ser menor que el de respuesta.',
      ),
    );
  }

  return ok({
    responseMinutes: input.responseMinutes,
    resolutionMinutes: input.resolutionMinutes,
  });
};

/** ¿Este objetivo lo pactó la organización o es el que trae el producto? */
export type SlaTargetSource = 'organization' | 'default';

export interface EffectiveSlaTarget extends SlaTarget {
  priority: TicketPriority;
  source: SlaTargetSource;
}

/**
 * La política que rige HOY, prioridad a prioridad y diciendo de dónde sale cada
 * objetivo.
 *
 * `resolvePolicy` ya combina overrides y defaults, pero se come justo el dato
 * que necesita quien va a editarla: sin `source`, un administrador no distingue
 * "esto lo pactamos así" de "esto nadie lo tocó nunca", y no puede saber si
 * cambiarlo rompe un acuerdo. Devuelve SIEMPRE las cuatro prioridades por el
 * mismo motivo por el que existe `DEFAULT_SLA_POLICY`: no hay tenant sin SLA.
 */
export const effectivePolicy = (
  overrides: Partial<Record<TicketPriority, SlaTarget>>,
): EffectiveSlaTarget[] =>
  TICKET_PRIORITIES.map((priority) => {
    const propio = overrides[priority];
    const target = propio ?? DEFAULT_SLA_POLICY[priority];
    return {
      priority,
      responseMinutes: target.responseMinutes,
      resolutionMinutes: target.resolutionMinutes,
      source: propio === undefined ? 'default' : 'organization',
    };
  });
