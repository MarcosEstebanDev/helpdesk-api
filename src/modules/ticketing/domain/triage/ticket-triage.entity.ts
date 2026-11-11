import { AggregateRoot } from '../../../../shared-kernel';
import { TicketTriaged, TicketingEvent } from '../events/ticketing.events';
import { TenantId, TicketId } from '../ids';
import { TicketPriority } from '../ticket-status';

/**
 * Valores que puede proponer el clasificador (ADR-0027).
 *
 * Son el MISMO contrato que el `schema.py` de helpdesk-ai, duplicado a propósito:
 * esta lista es la que decide qué se acepta en NUESTRA base de datos. El servicio
 * de IA es un sistema externo; si un día devuelve una categoría nueva, el adapter
 * la rechaza aquí en vez de guardarla sin que nadie lo haya decidido.
 */
export const TRIAGE_CATEGORIES = [
  'account_access',
  'billing',
  'bug',
  'how_to',
  'feature_request',
  'other',
] as const;
export type TriageCategory = (typeof TRIAGE_CATEGORIES)[number];
export const isTriageCategory = (v: string): v is TriageCategory =>
  (TRIAGE_CATEGORIES as readonly string[]).includes(v);

export const TRIAGE_SENTIMENTS = ['negative', 'neutral', 'positive'] as const;
export type TriageSentiment = (typeof TRIAGE_SENTIMENTS)[number];
export const isTriageSentiment = (v: string): v is TriageSentiment =>
  (TRIAGE_SENTIMENTS as readonly string[]).includes(v);

export const TRIAGE_LANGUAGES = ['es', 'en', 'pt', 'other'] as const;
export type TriageLanguage = (typeof TRIAGE_LANGUAGES)[number];
export const isTriageLanguage = (v: string): v is TriageLanguage =>
  (TRIAGE_LANGUAGES as readonly string[]).includes(v);

/** Lo que el clasificador propone sobre el ticket. */
export interface TriageClassification {
  category: TriageCategory;
  suggestedPriority: TicketPriority;
  sentiment: TriageSentiment;
  language: TriageLanguage;
}

/** Con qué se produjo la sugerencia: sin esto no se puede comparar nada después. */
export interface TriageProvenance {
  provider: string;
  model: string;
  promptVersion: string;
  latencyMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
}

interface TicketTriageProps {
  tenantId: TenantId;
  classification: TriageClassification;
  provenance: TriageProvenance;
  triagedAt: Date;
}

/**
 * Sugerencia de triage de un ticket (ADR-0027).
 *
 * Agregado propio y NO parte de `Ticket`, por la decisión de fondo del ADR: **la
 * IA sugiere, no decide.** Si la prioridad sugerida se escribiera en el ticket,
 * una salida del modelo cambiaría los relojes de SLA —que dependen de la
 * prioridad— sin que nadie la hubiera aceptado. Separada, el ticket solo cambia
 * cuando una persona lo decide.
 *
 * Hay como mucho una por ticket, así que su identidad ES la del ticket. Es
 * inmutable: un re-triage (otro modelo, otra versión del prompt) sería una
 * decisión nueva, no una edición de esta.
 */
export class TicketTriage extends AggregateRoot<TicketId, TicketingEvent> {
  private constructor(
    ticketId: TicketId,
    private readonly props: TicketTriageProps,
  ) {
    super(ticketId);
  }

  get ticketId(): TicketId {
    return this.id;
  }

  get tenantId(): TenantId {
    return this.props.tenantId;
  }

  get classification(): TriageClassification {
    return this.props.classification;
  }

  get provenance(): TriageProvenance {
    return this.props.provenance;
  }

  get triagedAt(): Date {
    return this.props.triagedAt;
  }

  static record(input: {
    ticketId: TicketId;
    tenantId: TenantId;
    classification: TriageClassification;
    provenance: TriageProvenance;
    /** Del ticket clasificado; solo viaja en el evento, no se persiste. */
    ticket: { number: number; priority: TicketPriority };
    now: Date;
  }): TicketTriage {
    const triage = new TicketTriage(input.ticketId, {
      tenantId: input.tenantId,
      classification: { ...input.classification },
      provenance: { ...input.provenance },
      triagedAt: input.now,
    });
    triage.addDomainEvent(
      new TicketTriaged(input.ticketId, input.tenantId, input.now, {
        ...input.classification,
        model: input.provenance.model,
        promptVersion: input.provenance.promptVersion,
        ticketNumber: input.ticket.number,
        ticketPriority: input.ticket.priority,
      }),
    );
    return triage;
  }

  static rehydrate(input: {
    ticketId: TicketId;
    tenantId: TenantId;
    classification: TriageClassification;
    provenance: TriageProvenance;
    triagedAt: Date;
  }): TicketTriage {
    return new TicketTriage(input.ticketId, {
      tenantId: input.tenantId,
      classification: { ...input.classification },
      provenance: { ...input.provenance },
      triagedAt: input.triagedAt,
    });
  }
}
