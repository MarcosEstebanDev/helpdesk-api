import { TicketPriority } from '../ticket-status';

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
