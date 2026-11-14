import { CannedResponse } from '../../domain/canned-response/canned-response.entity';
import { TenantId } from '../../domain/ids';
import { CannedResponseRepository } from '../../domain/ports/canned-response.repository';

/**
 * Las respuestas predefinidas de la organización, por título (ADR-0030).
 *
 * Pasa por un caso de uso y no por un read model (ADR-0008) porque la vista es
 * la entidad tal cual: no hay proyección que ahorrar, y así el orden lo decide
 * el puerto, igual en producción que en los tests.
 */
export class ListCannedResponses {
  constructor(private readonly responses: CannedResponseRepository) {}

  execute(input: { tenantId: TenantId }): Promise<CannedResponse[]> {
    return this.responses.list(input.tenantId);
  }
}
