import { DomainEvent } from './domain-event';

/**
 * Evento de dominio que además está pensado para SALIR del proceso: es lo que
 * se persiste en el outbox (ADR-0007) y acaba en una cola.
 *
 * Añade a `DomainEvent` lo que un consumidor necesita y el agregado no lleva:
 *
 * - `tenantId`: el worker no tiene JWT, así que reabre el contexto de tenant
 *   desde aquí antes de tocar la base de datos (ver modelo de seguridad).
 * - `aggregateType` + `aggregateId`: identifican qué cambió y permiten ordenar
 *   los eventos de un mismo agregado.
 * - `version`: el esquema del payload evoluciona; los consumidores viejos deben
 *   poder reconocer un formato que no entienden en vez de malinterpretarlo.
 * - `payload`: eventos "gordos" — el estado relevante EN EL MOMENTO del evento,
 *   para que el consumidor no tenga que releer (y ver algo ya distinto).
 */
export interface IntegrationEvent extends DomainEvent {
  readonly tenantId: string;
  readonly aggregateType: string;
  readonly version: number;
  readonly payload: Record<string, unknown>;
}
