import {
  Clock,
  Result,
  TransactionManager,
  err,
  ok,
} from '../../../../shared-kernel';
import {
  CannedResponseNotFoundError,
  TicketingError,
} from '../../domain/errors';
import { CannedResponseId, TenantId, UserId } from '../../domain/ids';
import { CannedResponseRepository } from '../../domain/ports/canned-response.repository';
import { AuditRecorder } from '../audit-recorder';
import { runTransactional } from '../transactional';

export interface DeleteCannedResponseInput {
  tenantId: TenantId;
  actorId: UserId;
  id: CannedResponseId;
}

/**
 * Borra una respuesta predefinida (ADR-0030). Es borrado FÍSICO: ningún
 * comentario apunta a ella (se rellena en el front y se manda como texto), así
 * que no deja nada colgando. Lo que sí queda es la auditoría con el título y el
 * cuerpo, para que "¿quién borró la respuesta de bienvenida?" tenga respuesta.
 */
export class DeleteCannedResponse {
  constructor(
    private readonly transactions: TransactionManager,
    private readonly responses: CannedResponseRepository,
    private readonly audit: AuditRecorder,
    private readonly clock: Clock,
  ) {}

  async execute(
    input: DeleteCannedResponseInput,
  ): Promise<Result<void, TicketingError>> {
    return runTransactional<void, TicketingError>(
      this.transactions,
      input.tenantId,
      async () => {
        const respuesta = await this.responses.findById(
          input.tenantId,
          input.id,
        );
        if (respuesta === null) return err(new CannedResponseNotFoundError());

        // Se mira el resultado: si otro ADMIN la borró entre medio, no se
        // escribe una segunda entrada de auditoría por el mismo borrado.
        if (!(await this.responses.remove(input.tenantId, input.id))) {
          return err(new CannedResponseNotFoundError());
        }
        await this.audit.record({
          tenantId: input.tenantId,
          actorId: input.actorId,
          action: 'canned_response.deleted',
          entityType: 'CannedResponse',
          entityId: respuesta.id,
          metadata: { title: respuesta.title, body: respuesta.body },
          now: this.clock.now(),
        });

        return ok(undefined);
      },
    );
  }
}
