import {
  Clock,
  IdGenerator,
  Result,
  TransactionManager,
  err,
  ok,
} from '../../../../shared-kernel';
import {
  DuplicateSavedViewNameError,
  SavedViewForbiddenError,
  TicketingError,
} from '../../domain/errors';
import { SavedViewId, TenantId, UserId } from '../../domain/ids';
import { SavedViewRepository } from '../../domain/ports/saved-view.repository';
import { SavedView } from '../../domain/saved-view/saved-view.entity';
import { runTransactional } from '../transactional';

/** Solo un ADMIN escribe vistas compartidas (ADR-0033, decisión 10). */
export const puedeEscribirCompartidas = (role: string): boolean =>
  role === 'ADMIN';

export interface CreateSavedViewInput {
  tenantId: TenantId;
  actorId: UserId;
  /** Del token verificado: decide si puede crear una compartida. */
  actorRole: string;
  name: string;
  filters: unknown;
  shared: boolean;
}

/**
 * Crea una vista guardada (ADR-0033). Personal: de quien la crea. Compartida
 * (`shared`): solo un ADMIN. Sin auditoría ni evento: es configuración de la
 * interfaz, no un dato del negocio.
 */
export class CreateSavedView {
  constructor(
    private readonly transactions: TransactionManager,
    private readonly views: SavedViewRepository,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async execute(
    input: CreateSavedViewInput,
  ): Promise<Result<SavedView, TicketingError>> {
    if (input.shared && !puedeEscribirCompartidas(input.actorRole)) {
      return err(new SavedViewForbiddenError());
    }
    const creada = SavedView.create({
      id: SavedViewId(this.ids.uuid()),
      tenantId: input.tenantId,
      ownerId: input.shared ? null : input.actorId,
      name: input.name,
      filters: input.filters,
      createdBy: input.actorId,
      now: this.clock.now(),
    });
    if (creada.isErr()) return err(creada.error);
    const vista = creada.value;

    return runTransactional<SavedView, TicketingError>(
      this.transactions,
      input.tenantId,
      async () => {
        if (
          await this.views.existsName(
            input.tenantId,
            vista.scopeKey,
            vista.nameKey,
          )
        ) {
          return err(new DuplicateSavedViewNameError());
        }
        await this.views.insert(vista);
        return ok(vista);
      },
    );
  }
}
