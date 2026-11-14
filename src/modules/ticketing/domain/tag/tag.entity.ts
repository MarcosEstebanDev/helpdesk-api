import { Entity, Result, err, ok } from '../../../../shared-kernel';
import { InvalidTagError } from '../errors';
import { TagId, TenantId } from '../ids';

/**
 * Paleta CERRADA (ADR-0031). Un hex libre acabaría con etiquetas ilegibles en
 * el modo oscuro; con nombres, el front decide el tono de cada tema.
 */
export const TAG_COLORS = [
  'gray',
  'red',
  'orange',
  'yellow',
  'green',
  'teal',
  'blue',
  'purple',
] as const;

export type TagColor = (typeof TAG_COLORS)[number];

export const isTagColor = (value: unknown): value is TagColor =>
  (TAG_COLORS as readonly unknown[]).includes(value);

export const TAG_NAME_MAX = 40;
export const MAX_TAGS_PER_TICKET = 10;

/** Clave de unicidad: "Bug" y " bug " son la misma etiqueta. */
export const canonicalTagKey = (name: string): string =>
  name.trim().toLowerCase();

interface TagProps {
  tenantId: TenantId;
  name: string;
  nameKey: string;
  color: TagColor;
  createdAt: Date;
  updatedAt: Date;
}

const validarNombre = (name: string): Result<string, InvalidTagError> => {
  const n = name.trim();
  if (n.length === 0) {
    return err(new InvalidTagError('El nombre no puede estar vacío.'));
  }
  if (n.length > TAG_NAME_MAX) {
    return err(
      new InvalidTagError(
        `El nombre no puede pasar de ${TAG_NAME_MAX} caracteres.`,
      ),
    );
  }
  return ok(n);
};

const validarColor = (color: string): Result<TagColor, InvalidTagError> =>
  isTagColor(color)
    ? ok(color)
    : err(
        new InvalidTagError(
          `"${color}" no es un color válido. Usá: ${TAG_COLORS.join(', ')}.`,
        ),
      );

/**
 * Etiqueta del catálogo de la organización (ADR-0031). Vive aparte del ticket:
 * renombrarla no toca ningún ticket, y la relación está en `ticket_tags`.
 */
export class Tag extends Entity<TagId> {
  private constructor(
    id: TagId,
    private readonly props: TagProps,
  ) {
    super(id);
  }

  get tenantId(): TenantId {
    return this.props.tenantId;
  }

  get name(): string {
    return this.props.name;
  }

  get nameKey(): string {
    return this.props.nameKey;
  }

  get color(): TagColor {
    return this.props.color;
  }

  get createdAt(): Date {
    return this.props.createdAt;
  }

  get updatedAt(): Date {
    return this.props.updatedAt;
  }

  static create(input: {
    id: TagId;
    tenantId: TenantId;
    name: string;
    color?: string;
    now: Date;
  }): Result<Tag, InvalidTagError> {
    const nombre = validarNombre(input.name);
    if (nombre.isErr()) return err(nombre.error);
    const color = validarColor(input.color ?? 'gray');
    if (color.isErr()) return err(color.error);

    return ok(
      new Tag(input.id, {
        tenantId: input.tenantId,
        name: nombre.value,
        nameKey: canonicalTagKey(nombre.value),
        color: color.value,
        createdAt: input.now,
        updatedAt: input.now,
      }),
    );
  }

  rename(name: string, now: Date): Result<void, InvalidTagError> {
    const nombre = validarNombre(name);
    if (nombre.isErr()) return err(nombre.error);
    this.props.name = nombre.value;
    this.props.nameKey = canonicalTagKey(nombre.value);
    this.props.updatedAt = now;
    return ok(undefined);
  }

  recolor(color: string, now: Date): Result<void, InvalidTagError> {
    const valido = validarColor(color);
    if (valido.isErr()) return err(valido.error);
    this.props.color = valido.value;
    this.props.updatedAt = now;
    return ok(undefined);
  }

  static rehydrate(input: { id: TagId } & TagProps): Tag {
    const { id, ...props } = input;
    return new Tag(id, { ...props });
  }
}
