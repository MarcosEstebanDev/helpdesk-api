/**
 * Registro de mensajes ya procesados, para idempotencia de consumidores
 * (ADR-0019).
 *
 * La entrega desde una cola es AT-LEAST-ONCE: el mismo evento puede llegar dos
 * veces —el publicador reintentó, el worker murió después de hacer el trabajo
 * pero antes de confirmar—. Un consumidor que no lo contemple asigna el ticket
 * dos veces, o manda dos emails.
 *
 * `claim` debe invocarse DENTRO de la transacción del efecto que protege: si el
 * trabajo revierte, la marca revierte con él y el reintento vuelve a intentarlo.
 * Marcarlo fuera de la transacción sería peor que no marcarlo, porque un fallo
 * dejaría el evento como "hecho" sin haberlo hecho.
 */
export interface ProcessedMessages {
  /**
   * Intenta reservar el mensaje para este consumidor.
   *
   * Devuelve `true` si es la primera vez (y por tanto hay que hacer el trabajo)
   * y `false` si ya estaba procesado (y hay que salir sin hacer nada).
   */
  claim(input: {
    consumer: string;
    eventId: string;
    tenantId: string;
  }): Promise<boolean>;
}

export const PROCESSED_MESSAGES = Symbol('shared.ProcessedMessages');
