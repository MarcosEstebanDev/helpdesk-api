import { Result } from '../../../../shared-kernel';
import { InvalidTagError, TooManyTagsError } from '../errors';
import { TagId, TenantId } from '../ids';
import {
  MAX_TAGS_PER_TICKET,
  TAG_NAME_MAX,
  Tag,
  canonicalTagKey,
} from './tag.entity';
import { diffTagSets } from './tag-set';

const TENANT = TenantId('11111111-1111-1111-1111-111111111111');
const ID = TagId('66666666-6666-6666-6666-666666666666');
const AHORA = new Date('2026-11-12T10:00:00.000Z');
const DESPUES = new Date('2026-11-12T11:00:00.000Z');

const valor = <T, E>(r: Result<T, E>): T => {
  if (r.isErr()) throw new Error('se esperaba ok');
  return r.value;
};
const error = <T, E>(r: Result<T, E>): E => {
  if (r.isOk()) throw new Error('se esperaba err');
  return r.error;
};

const crear = (name: string, color?: string) =>
  Tag.create({ id: ID, tenantId: TENANT, name, color, now: AHORA });

const ids = (...letras: string[]): TagId[] =>
  letras.map((l) => TagId(`${l.repeat(8)}-0000-0000-0000-000000000000`));

describe('Tag (ADR-0031)', () => {
  it('recorta el nombre, calcula la clave y usa gris por defecto', () => {
    const tag = valor(crear('  Facturación  '));

    expect(tag.name).toBe('Facturación');
    expect(tag.nameKey).toBe('facturación');
    expect(tag.color).toBe('gray');
  });

  it('canonicalTagKey recorta y pasa a minúsculas', () => {
    expect(canonicalTagKey('  VIP ')).toBe('vip');
  });

  it.each([
    ['vacío', '   ', undefined],
    ['largo', 'x'.repeat(TAG_NAME_MAX + 1), undefined],
    ['color fuera de la paleta', 'Bug', 'pink'],
  ])('rechaza un nombre o color inválido (%s)', (_caso, name, color) => {
    expect(error(crear(name, color))).toBeInstanceOf(InvalidTagError);
  });

  it('acepta un nombre de 40 y un color de la paleta', () => {
    const tag = valor(crear('x'.repeat(TAG_NAME_MAX), 'purple'));

    expect(tag.color).toBe('purple');
  });

  it('renombrar cambia nombre, clave y fecha', () => {
    const tag = valor(crear('Bug'));

    valor(tag.rename('Error', DESPUES));

    expect(tag.name).toBe('Error');
    expect(tag.nameKey).toBe('error');
    expect(tag.updatedAt).toEqual(DESPUES);
  });

  it('un renombre inválido no toca nada', () => {
    const tag = valor(crear('Bug'));

    expect(error(tag.rename('  ', DESPUES))).toBeInstanceOf(InvalidTagError);
    expect(tag.name).toBe('Bug');
    expect(tag.updatedAt).toEqual(AHORA);
  });

  it('recolorear con un color fuera de la paleta no toca nada', () => {
    const tag = valor(crear('Bug', 'red'));

    expect(error(tag.recolor('pink', DESPUES))).toBeInstanceOf(InvalidTagError);
    expect(tag.color).toBe('red');
  });
});

describe('diffTagSets (ADR-0031)', () => {
  it('calcula el conjunto nuevo, lo añadido y lo quitado', () => {
    const [a, b, c] = ids('a', 'b', 'c');

    expect(valor(diffTagSets([a, b], [b, c, c]))).toEqual({
      next: [b, c],
      added: [c],
      removed: [a],
    });
  });

  it('sin cambios no añade ni quita nada', () => {
    const [a, b] = ids('a', 'b');

    const r = valor(diffTagSets([a, b], [b, a]));

    expect(r.added).toEqual([]);
    expect(r.removed).toEqual([]);
  });

  it(`más de ${MAX_TAGS_PER_TICKET} distintas es un error`, () => {
    const once = ids('a', 'b', 'c', 'd', 'e', 'f', '1', '2', '3', '4', '5');

    expect(error(diffTagSets([], once))).toBeInstanceOf(TooManyTagsError);
  });

  it(`${MAX_TAGS_PER_TICKET} repetidas cuentan una vez cada una`, () => {
    const [a] = ids('a');

    expect(valor(diffTagSets([], Array(15).fill(a) as TagId[])).next).toEqual([
      a,
    ]);
  });
});
