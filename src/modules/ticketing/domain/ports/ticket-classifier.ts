import { Result } from '../../../../shared-kernel';
import { TriageRejectedError, TriageUnavailableError } from '../errors';
import {
  TriageClassification,
  TriageProvenance,
} from '../triage/ticket-triage.entity';

export interface ClassifierOutput {
  classification: TriageClassification;
  provenance: TriageProvenance;
}

/**
 * Puerto hacia el clasificador de IA (ADR-0027).
 *
 * Recibe SOLO el texto del ticket: ni ids, ni tenant, ni nada que permita al
 * servicio de IA relacionar un ticket con una organización. Es la frontera de
 * la decisión 1 del ADR — el servicio no tiene base de datos ni contexto de
 * tenant, así que un ticket malicioso que lo manipule no tiene nada que robar.
 *
 * El error distingue lo transitorio (reintentar) de lo permanente (descartar),
 * porque esa decisión la toma el consumidor de la cola y no el adapter.
 */
export interface TicketClassifier {
  classify(input: {
    subject: string;
    description: string;
  }): Promise<
    Result<ClassifierOutput, TriageUnavailableError | TriageRejectedError>
  >;
}

export const TICKET_CLASSIFIER = Symbol('ticketing.TicketClassifier');
