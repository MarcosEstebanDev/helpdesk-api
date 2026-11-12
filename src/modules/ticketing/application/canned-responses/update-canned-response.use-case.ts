import {
  Clock,
  Result,
  TransactionManager,
  err,
  ok,
} from '../../../../shared-kernel';
import { CannedResponse } from '../../domain/canned-response/canned-response.entity';
import {
  CannedResponseNotFoundError,
  DuplicateCannedResponseTitleError,
  TicketingError,
} from '../../domain/errors';
import { CannedResponseId, TenantId, UserId } from '../../domain/ids';
import { CannedResponseRepository } from '../../domain/ports/canned-response.repository';
import { AuditRecorder } from '../audit-recorder';
import { runTransactional } from '../transactional';

export interface UpdateCannedResponseInput {
  tenantId: TenantId;
  actorId: UserId;
  id: CannedResponseId;
  title: string;
  body: string;
}

/**
 * Reemplaza título y cuerpo de una respuesta predefinida (ADR-0030). La
 * auditoría guarda el antes y el después: el texto que el equipo le manda a los
 * clientes es algo de lo que se puede querer saber quién lo cambió.
 */
export class UpdateCannedResponse {
  constructor(
    private readonly transactions: TransactionManager,
    private readonly responses: CannedResponseRepository,
    private readonly audit: AuditRecorder,
    private readonly clock: Clock,
  ) {}

  async execute(
    input: UpdateCannedResponseInput,
  ): Promise<Result<CannedResponse, TicketingError>> {
    return runTransactional<CannedResponse, TicketingError>(
      this.transactions,
      input.tenantId,
      async () => {
        const respuesta = await this.responses.findById(
          input.tenantId,
          input.id,
        );
        if (respuesta === null) return err(new CannedResponseNotFoundError());

        const antes = { title: respuesta.title, body: respuesta.body };
        const now = this.clock.now();
        const reescrita = respuesta.rewrite({
          title: input.title,
          body: input.body,
          now,
        });
        if (reescrita.isErr()) return err(reescrita.error);

        if (
          await this.responses.existsTitleKey(
            input.tenantId,
            respuesta.titleKey,
            respuesta.id,
          )
        ) {
          return err(new DuplicateCannedResponseTitleError());
        }

        await this.responses.update(respuesta);
        await this.audit.record({
          tenantId: input.tenantId,
          actorId: input.actorId,
          action: 'canned_response.updated',
          entityType: 'CannedResponse',
          entityId: respuesta.id,
          metadata: {
            before: antes,
            after: { title: respuesta.title, body: respuesta.body },
          },
          now,
        });

        return ok(respuesta);
      },
    );
  }
}
