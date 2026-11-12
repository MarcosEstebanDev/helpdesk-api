import { Entity, Result, err, ok } from '../../../../shared-kernel';
import { InvalidCannedResponseError } from '../errors';
import { CannedResponseId, TenantId, UserId } from '../ids';
import { findInvalidPlaceholder } from './template-variables';

export const CANNED_TITLE_MAX = 80;
export const CANNED_BODY_MAX = 5000;

/**
 * Clave con la que se compara la unicidad del título: recortado y en
 * minúsculas, para que "Saludo" y " saludo " no convivan en el selector. Se
 * guarda en su propia columna (`title_key`) en vez de con un índice sobre
 * `lower(title)`, que Prisma no modela y daría drift permanente.
 */
export const canonicalTitleKey = (title: string): string =>
  title.trim().toLowerCase();

interface CannedResponseProps {
  tenantId: TenantId;
  title: string;
  titleKey: string;
  body: string;
  createdBy: UserId;
  createdAt: Date;
  updatedAt: Date;
}

/** Valida y normaliza título y cuerpo. Una sola regla para crear y reescribir. */
const validar = (
  title: string,
  body: string,
): Result<{ title: string; body: string }, InvalidCannedResponseError> => {
  const t = title.trim();
  const b = body.trim();

  if (t.length === 0) {
    return err(new InvalidCannedResponseError('El título no puede estar vacío.'));
  }
  if (t.length > CANNED_TITLE_MAX) {
    return err(
      new InvalidCannedResponseError(
        `El título no puede pasar de ${CANNED_TITLE_MAX} caracteres.`,
      ),
    );
  }
  if (b.length === 0) {
    return err(new InvalidCannedResponseError('El texto no puede estar vacío.'));
  }
  if (b.length > CANNED_BODY_MAX) {
    return err(
      new InvalidCannedResponseError(
        `El texto no puede pasar de ${CANNED_BODY_MAX} caracteres.`,
      ),
    );
  }

  const mala = findInvalidPlaceholder(b);
  if (mala !== null) {
    return err(
      new InvalidCannedResponseError(
        `"${mala}" no es una variable válida. Usá {{ticket.numero}}, {{ticket.asunto}}, {{cliente.email}} o {{agente.email}}.`,
      ),
    );
  }

  return ok({ title: t, body: b });
};

/**
 * Respuesta predefinida de la organización (ADR-0030).
 *
 * Solo TEXTO: insertarla no cambia nada del ticket (eso serían "macros", que son
 * automatización). Las variables se rellenan en el front al insertarla; aquí
 * solo se garantiza que todas las que aparecen son conocidas.
 */
export class CannedResponse extends Entity<CannedResponseId> {
  private constructor(
    id: CannedResponseId,
    private readonly props: CannedResponseProps,
  ) {
    super(id);
  }

  get tenantId(): TenantId {
    return this.props.tenantId;
  }

  get title(): string {
    return this.props.title;
  }

  get titleKey(): string {
    return this.props.titleKey;
  }

  get body(): string {
    return this.props.body;
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
    id: CannedResponseId;
    tenantId: TenantId;
    title: string;
    body: string;
    createdBy: UserId;
    now: Date;
  }): Result<CannedResponse, InvalidCannedResponseError> {
    const valido = validar(input.title, input.body);
    if (valido.isErr()) return err(valido.error);

    return ok(
      new CannedResponse(input.id, {
        tenantId: input.tenantId,
        title: valido.value.title,
        titleKey: canonicalTitleKey(valido.value.title),
        body: valido.value.body,
        createdBy: input.createdBy,
        createdAt: input.now,
        updatedAt: input.now,
      }),
    );
  }

  /** Reemplaza título y cuerpo juntos. Si algo no valida, no cambia nada. */
  rewrite(input: {
    title: string;
    body: string;
    now: Date;
  }): Result<void, InvalidCannedResponseError> {
    const valido = validar(input.title, input.body);
    if (valido.isErr()) return err(valido.error);

    this.props.title = valido.value.title;
    this.props.titleKey = canonicalTitleKey(valido.value.title);
    this.props.body = valido.value.body;
    this.props.updatedAt = input.now;
    return ok(undefined);
  }

  static rehydrate(
    input: { id: CannedResponseId } & CannedResponseProps,
  ): CannedResponse {
    const { id, ...props } = input;
    return new CannedResponse(id, { ...props });
  }
}
