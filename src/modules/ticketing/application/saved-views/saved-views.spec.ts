import {
  DuplicateSavedViewNameError,
  InvalidSavedViewError,
  SavedViewForbiddenError,
  SavedViewNotFoundError,
} from '../../domain/errors';
import { SavedViewId, UserId } from '../../domain/ids';
import { SavedView } from '../../domain/saved-view/saved-view.entity';
import {
  TENANT,
  fakeSavedViews,
  fakeTransactions,
  fixedClock,
  sequentialIds,
} from '../ticketing.test-doubles';
import { CreateSavedView } from './create-saved-view.use-case';
import { DeleteSavedView } from './delete-saved-view.use-case';
import { ListSavedViews } from './list-saved-views.use-case';
import { UpdateSavedView } from './update-saved-view.use-case';

const AHORA = new Date('2026-11-13T10:00:00.000Z');
const ANA = UserId('22222222-2222-2222-2222-222222222222');
const BETO = UserId('33333333-3333-3333-3333-333333333333');
const PERSONAL_ANA = SavedViewId('aaaaaaaa-0000-0000-0000-000000000001');
const COMPARTIDA = SavedViewId('aaaaaaaa-0000-0000-0000-000000000002');
const NO_EXISTE = SavedViewId('aaaaaaaa-0000-0000-0000-000000000009');

const vista = (id: SavedViewId, name: string, ownerId: UserId | null) => {
  const r = SavedView.create({
    id,
    tenantId: TENANT,
    ownerId,
    name,
    filters: { version: 1 },
    createdBy: ANA,
    now: AHORA,
  });
  if (r.isErr()) throw new Error(r.error.message);
  return r.value;
};

const montar = () => {
  const views = fakeSavedViews();
  views.seed(vista(PERSONAL_ANA, 'Mis urgentes', ANA));
  views.seed(vista(COMPARTIDA, 'Sin asignar', null));
  const transactions = fakeTransactions();
  const clock = fixedClock(AHORA);
  return {
    views,
    list: new ListSavedViews(views),
    create: new CreateSavedView(
      transactions.manager,
      views,
      sequentialIds(),
      clock,
    ),
    update: new UpdateSavedView(transactions.manager, views, clock),
    remove: new DeleteSavedView(transactions.manager, views),
  };
};

const base = { tenantId: TENANT };

describe('ListSavedViews (ADR-0033)', () => {
  it('cada uno ve las compartidas y las suyas, compartidas primero', async () => {
    const { list } = montar();

    const deAna = await list.execute({ ...base, actorId: ANA });
    const deBeto = await list.execute({ ...base, actorId: BETO });

    expect(deAna.map((v) => v.name)).toEqual(['Sin asignar', 'Mis urgentes']);
    expect(deBeto.map((v) => v.name)).toEqual(['Sin asignar']);
  });
});

describe('CreateSavedView (ADR-0033)', () => {
  it('un agente crea una vista personal', async () => {
    const { create, views } = montar();

    const r = await create.execute({
      ...base,
      actorId: BETO,
      actorRole: 'AGENT',
      name: 'Mis VIP',
      filters: { version: 1, assignee: 'me' },
      shared: false,
    });

    expect(r.isOk()).toBe(true);
    if (r.isErr()) return;
    expect(views.stored(r.value.id)?.ownerId).toBe(BETO);
  });

  it('un agente NO crea una compartida', async () => {
    const { create } = montar();

    const r = await create.execute({
      ...base,
      actorId: BETO,
      actorRole: 'AGENT',
      name: 'Para todos',
      filters: { version: 1 },
      shared: true,
    });

    expect(r.isErr()).toBe(true);
    if (r.isOk()) return;
    expect(r.error).toBeInstanceOf(SavedViewForbiddenError);
  });

  it('un ADMIN crea una compartida', async () => {
    const { create, views } = montar();

    const r = await create.execute({
      ...base,
      actorId: ANA,
      actorRole: 'ADMIN',
      name: 'Urgentes del equipo',
      filters: { version: 1, status: 'OPEN' },
      shared: true,
    });

    expect(r.isOk()).toBe(true);
    if (r.isErr()) return;
    expect(views.stored(r.value.id)?.isShared).toBe(true);
  });

  it('el mismo nombre en vistas personales de dos personas está permitido', async () => {
    const { create } = montar();

    const r = await create.execute({
      ...base,
      actorId: BETO,
      actorRole: 'AGENT',
      name: 'MIS URGENTES',
      filters: { version: 1 },
      shared: false,
    });

    expect(r.isOk()).toBe(true);
  });

  it('dos compartidas con el mismo nombre no', async () => {
    const { create } = montar();

    const r = await create.execute({
      ...base,
      actorId: ANA,
      actorRole: 'ADMIN',
      name: 'sin asignar',
      filters: { version: 1 },
      shared: true,
    });

    expect(r.isErr()).toBe(true);
    if (r.isOk()) return;
    expect(r.error).toBeInstanceOf(DuplicateSavedViewNameError);
  });

  it('filtros inválidos no llegan al repositorio', async () => {
    const { create } = montar();

    const r = await create.execute({
      ...base,
      actorId: BETO,
      actorRole: 'AGENT',
      name: 'Rota',
      filters: { version: 1, assignee: ANA },
      shared: false,
    });

    expect(r.isErr()).toBe(true);
    if (r.isOk()) return;
    expect(r.error).toBeInstanceOf(InvalidSavedViewError);
  });
});

describe('UpdateSavedView y DeleteSavedView (ADR-0033)', () => {
  const cambio = {
    name: 'Otro nombre',
    filters: { version: 1, status: 'OPEN' },
  };

  it('el dueño edita su vista personal', async () => {
    const { update, views } = montar();

    const r = await update.execute({
      ...base,
      actorId: ANA,
      actorRole: 'AGENT',
      id: PERSONAL_ANA,
      ...cambio,
    });

    expect(r.isOk()).toBe(true);
    expect(views.stored(PERSONAL_ANA)?.name).toBe('Otro nombre');
  });

  it('la vista personal de otro es invisible: not found, aunque sea ADMIN', async () => {
    const { update, remove, views } = montar();

    const editar = await update.execute({
      ...base,
      actorId: BETO,
      actorRole: 'ADMIN',
      id: PERSONAL_ANA,
      ...cambio,
    });
    const borrar = await remove.execute({
      ...base,
      actorId: BETO,
      actorRole: 'ADMIN',
      id: PERSONAL_ANA,
    });

    expect(editar.isErr() && editar.error).toBeInstanceOf(
      SavedViewNotFoundError,
    );
    expect(borrar.isErr() && borrar.error).toBeInstanceOf(
      SavedViewNotFoundError,
    );
    expect(views.stored(PERSONAL_ANA)?.name).toBe('Mis urgentes');
  });

  it('un agente no edita ni borra una compartida', async () => {
    const { update, remove, views } = montar();

    const editar = await update.execute({
      ...base,
      actorId: BETO,
      actorRole: 'AGENT',
      id: COMPARTIDA,
      ...cambio,
    });
    const borrar = await remove.execute({
      ...base,
      actorId: BETO,
      actorRole: 'AGENT',
      id: COMPARTIDA,
    });

    expect(editar.isErr() && editar.error).toBeInstanceOf(
      SavedViewForbiddenError,
    );
    expect(borrar.isErr() && borrar.error).toBeInstanceOf(
      SavedViewForbiddenError,
    );
    expect(views.stored(COMPARTIDA)?.name).toBe('Sin asignar');
  });

  it('un ADMIN borra una compartida', async () => {
    const { remove, views } = montar();

    const r = await remove.execute({
      ...base,
      actorId: ANA,
      actorRole: 'ADMIN',
      id: COMPARTIDA,
    });

    expect(r.isOk()).toBe(true);
    expect(views.stored(COMPARTIDA)).toBeNull();
  });

  it('una que no existe es not found', async () => {
    const { remove } = montar();

    const r = await remove.execute({
      ...base,
      actorId: ANA,
      actorRole: 'ADMIN',
      id: NO_EXISTE,
    });

    expect(r.isErr() && r.error).toBeInstanceOf(SavedViewNotFoundError);
  });
});
