import { Entity, Result, err, ok } from '../../../../shared-kernel';
import { InvalidSavedViewError } from '../errors';
import { SavedViewId, TenantId, UserId } from '../ids';
import { ViewFilters, parseViewFilters } from './view-filters';

export const SAVED_VIEW_NAME_MAX = 60;

/** Ámbito de unicidad del nombre: las compartidas entre sí, las de cada uno entre sí. */
export const SHARED_SCOPE = 'shared';

interface SavedViewProps {
  tenantId: TenantId;
  /** `null` = compartida con todo el equipo (solo un ADMIN la escribe). */
  ownerId: UserId | null;
  name: string;
  nameKey: string;
  filters: ViewFilters;
  createdBy: UserId;
  createdAt: Date;
  updatedAt: Date;
}

const validarNombre = (name: string): Result<string, InvalidSavedViewError> => {
  const n = name.trim();
  if (n.length === 0) {
    return err(new InvalidSavedViewError('El nombre no puede estar vacío.'));
  }
  if (n.length > SAVED_VIEW_NAME_MAX) {
    return err(
      new InvalidSavedViewError(
        `El nombre no puede pasar de ${SAVED_VIEW_NAME_MAX} caracteres.`,
      ),
    );
  }
  return ok(n);
};

/**
 * Vista guardada de la bandeja (ADR-0033): un nombre y un conjunto de filtros.
 * Personal (de su dueño) o compartida (`ownerId` null). Los filtros se validan
 * con `parseViewFilters` en cada escritura.
 */
export class SavedView extends Entity<SavedViewId> {
  private constructor(
    id: SavedViewId,
    private readonly props: SavedViewProps,
  ) {
    super(id);
  }

  get tenantId(): TenantId {
    return this.props.tenantId;
  }

  get ownerId(): UserId | null {
    return this.props.ownerId;
  }

  get isShared(): boolean {
    return this.props.ownerId === null;
  }

  get scopeKey(): string {
    return this.props.ownerId ?? SHARED_SCOPE;
  }

  get name(): string {
    return this.props.name;
  }

  get nameKey(): string {
    return this.props.nameKey;
  }

  get filters(): ViewFilters {
    return this.props.filters;
  }

  get createdBy(): UserId {
    return this.props.createdBy;
  }

  get createdAt(): Date {
    return this.props.createdAt;
  }

  get updatedAt(): Date {
    return this.props.updatedAt;
  }

  static create(input: {
    id: SavedViewId;
    tenantId: TenantId;
    ownerId: UserId | null;
    name: string;
    filters: unknown;
    createdBy: UserId;
    now: Date;
  }): Result<SavedView, InvalidSavedViewError> {
    const nombre = validarNombre(input.name);
    if (nombre.isErr()) return err(nombre.error);
    const filtros = parseViewFilters(input.filters);
    if (filtros.isErr()) return err(filtros.error);

    return ok(
      new SavedView(input.id, {
        tenantId: input.tenantId,
        ownerId: input.ownerId,
        name: nombre.value,
        nameKey: nombre.value.toLowerCase(),
        filters: filtros.value,
        createdBy: input.createdBy,
        createdAt: input.now,
        updatedAt: input.now,
      }),
    );
  }

  /** Reemplaza nombre y filtros. Si algo no valida, no cambia nada. */
  rewrite(input: {
    name: string;
    filters: unknown;
    now: Date;
  }): Result<void, InvalidSavedViewError> {
    const nombre = validarNombre(input.name);
    if (nombre.isErr()) return err(nombre.error);
    const filtros = parseViewFilters(input.filters);
    if (filtros.isErr()) return err(filtros.error);

    this.props.name = nombre.value;
    this.props.nameKey = nombre.value.toLowerCase();
    this.props.filters = filtros.value;
    this.props.updatedAt = input.now;
    return ok(undefined);
  }

  static rehydrate(input: { id: SavedViewId } & SavedViewProps): SavedView {
    const { id, ...props } = input;
    return new SavedView(id, { ...props });
  }
}
