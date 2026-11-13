import { Result } from '../../../../shared-kernel';
import { InvalidSavedViewError } from '../errors';
import { SavedViewId, TenantId, UserId } from '../ids';
import { SAVED_VIEW_NAME_MAX, SavedView } from './saved-view.entity';
import { parseViewFilters } from './view-filters';

const TENANT = TenantId('11111111-1111-1111-1111-111111111111');
const ANA = UserId('22222222-2222-2222-2222-222222222222');
const ID = SavedViewId('66666666-6666-6666-6666-666666666666');
const TAG = '77777777-7777-7777-7777-777777777777';
const AHORA = new Date('2026-11-13T10:00:00.000Z');

const valor = <T, E>(r: Result<T, E>): T => {
  if (r.isErr()) throw new Error('se esperaba ok');
  return r.value;
};
const error = <T, E>(r: Result<T, E>): E => {
  if (r.isOk()) throw new Error('se esperaba err');
  return r.error;
};

describe('parseViewFilters (ADR-0033)', () => {
  it('acepta todos los filtros v1', () => {
    expect(
      valor(
        parseViewFilters({
          version: 1,
          status: 'IN_PROGRESS',
          assignee: 'me',
          tagIds: [TAG],
          q: '  pdf  ',
          aiSuggestsHigher: true,
        }),
      ),
    ).toEqual({
      version: 1,
      status: 'IN_PROGRESS',
      assignee: 'me',
      tagIds: [TAG],
      q: 'pdf',
      aiSuggestsHigher: true,
    });
  });

  it('una vista sin filtros es válida (versión sola)', () => {
    expect(valor(parseViewFilters({ version: 1 }))).toEqual({ version: 1 });
  });

  it('omite lo vacío: texto en blanco y lista de etiquetas vacía', () => {
    expect(
      valor(parseViewFilters({ version: 1, q: '   ', tagIds: [] })),
    ).toEqual({
      version: 1,
    });
  });

  it.each([
    ['no es un objeto', 'hola', ''],
    ['versión desconocida', { version: 2 }, 'version'],
    ['sin versión', {}, 'version'],
    ['clave desconocida', { version: 1, priority: 'HIGH' }, 'priority'],
    ['estado inválido', { version: 1, status: 'ARCHIVED' }, 'status'],
    ['asignado que no es "me"', { version: 1, assignee: ANA }, 'assignee'],
    ['etiqueta que no es uuid', { version: 1, tagIds: ['x'] }, 'tagIds'],
    [
      '11 etiquetas distintas',
      {
        version: 1,
        tagIds: Array.from(
          { length: 11 },
          (_, i) => `${String(i).padStart(8, '0')}-0000-0000-0000-000000000000`,
        ),
      },
      'tagIds',
    ],
    ['texto de 201', { version: 1, q: 'x'.repeat(201) }, 'q'],
    [
      'IA en false',
      { version: 1, aiSuggestsHigher: false },
      'aiSuggestsHigher',
    ],
  ])('rechaza %s y nombra el campo', (_caso, raw, campo) => {
    const e = error(parseViewFilters(raw));
    expect(e).toBeInstanceOf(InvalidSavedViewError);
    expect(e.message).toContain(campo);
  });

  it('las etiquetas se guardan en minúsculas y sin repetir', () => {
    expect(
      valor(parseViewFilters({ version: 1, tagIds: [TAG.toUpperCase(), TAG] }))
        .tagIds,
    ).toEqual([TAG]);
  });
});

describe('SavedView (ADR-0033)', () => {
  const crear = (name: string, ownerId: UserId | null) =>
    SavedView.create({
      id: ID,
      tenantId: TENANT,
      ownerId,
      name,
      filters: { version: 1 },
      createdBy: ANA,
      now: AHORA,
    });

  it('una personal tiene como ámbito a su dueño; una compartida, "shared"', () => {
    const personal = valor(crear('Mis urgentes', ANA));
    const compartida = valor(crear('Sin asignar', null));

    expect(personal.isShared).toBe(false);
    expect(personal.scopeKey).toBe(ANA);
    expect(compartida.isShared).toBe(true);
    expect(compartida.scopeKey).toBe('shared');
  });

  it('recorta el nombre y calcula la clave', () => {
    const vista = valor(crear('  Mis VIP ', ANA));

    expect(vista.name).toBe('Mis VIP');
    expect(vista.nameKey).toBe('mis vip');
  });

  it.each([
    ['vacío', '  '],
    ['largo', 'x'.repeat(SAVED_VIEW_NAME_MAX + 1)],
  ])('rechaza un nombre %s', (_caso, name) => {
    expect(error(crear(name, ANA))).toBeInstanceOf(InvalidSavedViewError);
  });

  it('reescribir cambia nombre y filtros; si es inválido no toca nada', () => {
    const vista = valor(crear('Uno', ANA));

    valor(
      vista.rewrite({
        name: 'Dos',
        filters: { version: 1, assignee: 'me' },
        now: AHORA,
      }),
    );
    expect(vista.name).toBe('Dos');
    expect(vista.filters).toEqual({ version: 1, assignee: 'me' });

    expect(
      error(vista.rewrite({ name: ' ', filters: { version: 1 }, now: AHORA })),
    ).toBeInstanceOf(InvalidSavedViewError);
    expect(vista.name).toBe('Dos');
  });
});
