import {
  Clock,
  IdGenerator,
  Result,
  TransactionManager,
  err,
  ok,
} from '../../../../shared-kernel';
import { CannedResponse } from '../../domain/canned-response/canned-response.entity';
import {
  DuplicateCannedResponseTitleError,
  TicketingError,
} from '../../domain/errors';
import { CannedResponseId, TenantId, UserId } from '../../domain/ids';
import { CannedResponseRepository } from '../../domain/ports/canned-response.repository';
import { AuditRecorder } from '../audit-recorder';
import { runTransactional } from '../transactional';

export interface CreateCannedResponseInput {
  tenantId: TenantId;
  actorId: UserId;
  title: string;
  body: string;
}

/**
 * Da de alta una respuesta predefinida (ADR-0030). Solo la llama un ADMIN; el
 * rango lo comprueba el borde HTTP.
 *
 * La unicidad del título se mira DENTRO de la transacción para dar un error
 * claro en el caso normal. La restricción única de la base es la red para la
 * carrera entre dos administradores, y el borde la traduce al mismo 409.
 */
export class CreateCannedResponse {
  constructor(
    private readonly transactions: TransactionManager,
    private readonly responses: CannedResponseRepository,
    private readonly audit: AuditRecorder,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async execute(
    input: CreateCannedResponseInput,
  ): Promise<Result<CannedResponse, TicketingError>> {
    const now = this.clock.now();
    const creada = CannedResponse.create({
      id: CannedResponseId(this.ids.uuid()),
      tenantId: input.tenantId,
      title: input.title,
      body: input.body,
      createdBy: input.actorId,
      now,
    });
    if (creada.isErr()) return err(creada.error);
    const respuesta = creada.value;

    return runTransactional<CannedResponse, TicketingError>(
      this.transactions,
      input.tenantId,
      async () => {
        if (
          await this.responses.existsTitleKey(
            input.tenantId,
            respuesta.titleKey,
          )
        ) {
          return err(new DuplicateCannedResponseTitleError());
        }

        await this.responses.insert(respuesta);
        await this.audit.record({
          tenantId: input.tenantId,
          actorId: input.actorId,
          action: 'canned_response.created',
          entityType: 'CannedResponse',
          entityId: respuesta.id,
          metadata: { title: respuesta.title },
          now,
        });

        return ok(respuesta);
      },
    );
  }
}
