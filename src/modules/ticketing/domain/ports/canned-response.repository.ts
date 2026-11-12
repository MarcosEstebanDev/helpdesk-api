import { CannedResponse } from '../canned-response/canned-response.entity';
import { CannedResponseId, TenantId } from '../ids';

/** Respuestas predefinidas de la organización (ADR-0030). */
export interface CannedResponseRepository {
  /** Todas las de la organización, ordenadas por título (`title_key`). */
  list(tenantId: TenantId): Promise<CannedResponse[]>;

  findById(
    tenantId: TenantId,
    id: CannedResponseId,
  ): Promise<CannedResponse | null>;

  /**
   * ¿Ya hay otra con ese título normalizado? `exceptId` excluye a la propia
   * plantilla: cambiar "Saludo" por "saludo" no choca consigo misma.
   */
  existsTitleKey(
    tenantId: TenantId,
    titleKey: string,
    exceptId?: CannedResponseId,
  ): Promise<boolean>;

  insert(response: CannedResponse): Promise<void>;

  update(response: CannedResponse): Promise<void>;

  /** Devuelve si había algo que borrar. */
  remove(tenantId: TenantId, id: CannedResponseId): Promise<boolean>;
}

export const CANNED_RESPONSE_REPOSITORY = Symbol(
  'ticketing.CannedResponseRepository',
);
