import {
  Clock,
  ProcessedMessages,
  Result,
  TransactionManager,
  err,
  ok,
} from '../../../../shared-kernel';
import { TicketingError } from '../../domain/errors';
import { TenantId, TicketId } from '../../domain/ids';
import { TicketClassifier } from '../../domain/ports/ticket-classifier';
import { TicketTriageRepository } from '../../domain/ports/ticket-triage.repository';
import { TicketRepository } from '../../domain/ports/ticket.repository';
import { SYSTEM_ACTOR_ID } from '../../domain/system-actor';
import { TicketTriage } from '../../domain/triage/ticket-triage.entity';
import { AuditRecorder } from '../audit-recorder';
import { EventRecorder } from '../event-recorder';
import { runTransactional } from '../transactional';

export const TRIAGE_CONSUMER = 'ticketing.ai-triage';

export interface TriageTicketInput {
  /** Id del MENSAJE del outbox: clave de idempotencia (ADR-0019). */
  eventId: string;
  tenantId: TenantId;
  ticketId: TicketId;
}

export type TriageOutcome =
  | { status: 'triaged'; category: string; suggestedPriority: string }
  | {
      status: 'skipped';
      reason: 'already_processed' | 'already_triaged' | 'ticket_not_found';
    };

/**
 * Pide al servicio de IA una clasificación del ticket y la guarda como
 * SUGERENCIA (ADR-0027).
 *
 * **La llamada al modelo va FUERA de la transacción.** Con un modelo local en
 * CPU puede tardar decenas de segundos, y una transacción abierta todo ese
 * tiempo retendría una conexión del pool —con un pool chico, unos pocos tickets
 * a la vez bastarían para dejar sin conexiones a la API—. Por eso son tres
 * pasos:
 *
 * 1. Comprobaciones baratas sin transacción: ¿existe el ticket?, ¿ya tiene
 *    triage? Evitan pagar una llamada al modelo para nada.
 * 2. La llamada al modelo, sin nada abierto.
 * 3. Una transacción corta con la marca de procesado, la sugerencia, la
 *    auditoría y el evento — juntos o nada, como en el resto de consumidores.
 *
 * El precio: si dos entregas del mismo evento corren a la vez, las dos pagan el
 * modelo y solo una guarda (la otra choca con `processed_messages`). Es un
 * desperdicio acotado y raro, y a cambio la base de datos nunca espera a la IA.
 */
export class TriageTicket {
  constructor(
    private readonly transactions: TransactionManager,
    private readonly tickets: TicketRepository,
    private readonly triages: TicketTriageRepository,
    private readonly classifier: TicketClassifier,
    private readonly processed: ProcessedMessages,
    private readonly audit: AuditRecorder,
    private readonly events: EventRecorder,
    private readonly clock: Clock,
  ) {}

  async execute(
    input: TriageTicketInput,
  ): Promise<Result<TriageOutcome, TicketingError>> {
    // --- 1. Comprobaciones baratas --------------------------------------
    if (await this.triages.findByTicket(input.tenantId, input.ticketId)) {
      return ok({ status: 'skipped', reason: 'already_triaged' } as const);
    }
    const ticket = await this.tickets.findById(input.tenantId, input.ticketId);
    if (ticket === null) {
      return ok({ status: 'skipped', reason: 'ticket_not_found' } as const);
    }

    // --- 2. El modelo, sin transacción abierta ----------------------------
    const classified = await this.classifier.classify({
      subject: ticket.subject,
      description: ticket.description,
    });
    if (classified.isErr()) {
      // Transitorio o permanente: decide el consumidor (reintentar vs DLQ).
      return err(classified.error);
    }
    const { classification, provenance } = classified.value;

    // --- 3. Transacción corta ---------------------------------------------
    const now = this.clock.now();
    return runTransactional<TriageOutcome, TicketingError>(
      this.transactions,
      input.tenantId,
      async () => {
        const primeraVez = await this.processed.claim({
          consumer: TRIAGE_CONSUMER,
          eventId: input.eventId,
          tenantId: input.tenantId,
        });
        if (!primeraVez) {
          return ok({
            status: 'skipped',
            reason: 'already_processed',
          } as const);
        }

        const triage = TicketTriage.record({
          ticketId: ticket.id,
          tenantId: input.tenantId,
          classification,
          provenance,
          ticket: { number: ticket.number, priority: ticket.priority },
          now,
        });
        await this.triages.save(triage);
        await this.audit.record({
          tenantId: input.tenantId,
          actorId: SYSTEM_ACTOR_ID,
          action: 'ticket.triaged',
          entityType: 'ticket',
          entityId: ticket.id,
          metadata: {
            category: classification.category,
            suggestedPriority: classification.suggestedPriority,
            model: provenance.model,
            promptVersion: provenance.promptVersion,
            automatic: true,
          },
          now,
        });
        await this.events.record(triage);

        return ok({
          status: 'triaged',
          category: classification.category,
          suggestedPriority: classification.suggestedPriority,
        } as const);
      },
    );
  }
}
