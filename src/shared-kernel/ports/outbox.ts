import { IntegrationEvent } from '../domain/integration-event';

/** Un {@link IntegrationEvent} ya con su identidad de mensaje asignada. */
export interface OutboxRecord extends IntegrationEvent {
  readonly id: string;
}

/**
 * Escritura en el outbox transaccional (ADR-0007).
 *
 * Solo `append`: la lectura y el marcado los hace el publicador, que corre
 * fuera de toda request y con privilegios distintos (ver ADR-0018). Meter aquí
 * un `findUnpublished` daría a los casos de uso acceso a algo que no les toca.
 *
 * Debe invocarse DENTRO de la transacción del cambio que origina los eventos
 * (ADR-0016): esa es toda la garantía del patrón.
 */
export interface OutboxWriter {
  append(records: readonly OutboxRecord[]): Promise<void>;
}

export const OUTBOX_WRITER = Symbol('shared.OutboxWriter');
