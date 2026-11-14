import { Result } from '../../../../shared-kernel';
import { CannedResponseId, TenantId, UserId } from '../ids';
import { InvalidCannedResponseError } from '../errors';
import {
  CANNED_BODY_MAX,
  CANNED_TITLE_MAX,
  CannedResponse,
  canonicalTitleKey,
} from './canned-response.entity';
import { findInvalidPlaceholder } from './template-variables';

const TENANT = TenantId('11111111-1111-1111-1111-111111111111');
const AUTOR = UserId('22222222-2222-2222-2222-222222222222');
const ID = CannedResponseId('66666666-6666-6666-6666-666666666666');
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

const crear = (title: string, body: string) =>
  CannedResponse.create({
    id: ID,
    tenantId: TENANT,
    title,
    body,
    createdBy: AUTOR,
    now: AHORA,
  });

describe('findInvalidPlaceholder (ADR-0030)', () => {
  it.each([
    'Hola {{ticket.numero}}',
    '{{ ticket.asunto }}',
    'Texto sin llaves',
    'Un JSON {a: 1} con llaves simples',
    '{{ticket.numero}} {{ticket.asunto}} {{cliente.email}} {{agente.email}}',
  ])('acepta %p', (body) => {
    expect(findInvalidPlaceholder(body)).toBeNull();
  });

  it('nombra la variable desconocida entera', () => {
    expect(findInvalidPlaceholder('Hola {{clinete.email}}')).toBe(
      '{{clinete.email}}',
    );
  });

  it('una llave sin cerrar es un error', () => {
    expect(findInvalidPlaceholder('Hola {{ticket.numero')).toBe('{{');
  });

  it('una llave de cierre suelta es un error', () => {
    expect(findInvalidPlaceholder('fin }}')).toBe('}}');
  });

  it('una variable vacía es un error', () => {
    expect(findInvalidPlaceholder('{{}}')).toBe('{{}}');
  });

  it('las llaves triples no cuentan como variable válida', () => {
    expect(findInvalidPlaceholder('{{{ticket.numero}}}')).not.toBeNull();
  });

  it('distingue mayúsculas', () => {
    expect(findInvalidPlaceholder('{{Ticket.Numero}}')).toBe(
      '{{Ticket.Numero}}',
    );
  });
});

describe('CannedResponse', () => {
  it('recorta título y cuerpo y calcula la clave del título', () => {
    const r = crear('  Saludo Inicial ', '  Hola {{ticket.numero}}  ');

    expect(r.isOk()).toBe(true);
    const plantilla = valor(r);
    expect(plantilla.title).toBe('Saludo Inicial');
    expect(plantilla.titleKey).toBe('saludo inicial');
    expect(plantilla.body).toBe('Hola {{ticket.numero}}');
    expect(plantilla.createdAt).toEqual(AHORA);
    expect(plantilla.updatedAt).toEqual(AHORA);
  });

  it('canonicalTitleKey recorta y pasa a minúsculas', () => {
    expect(canonicalTitleKey('  Hola MUNDO ')).toBe('hola mundo');
  });

  it.each([
    ['título vacío', '   ', 'cuerpo'],
    ['título largo', 'x'.repeat(CANNED_TITLE_MAX + 1), 'cuerpo'],
    ['cuerpo vacío', 'Título', '  '],
    ['cuerpo largo', 'Título', 'x'.repeat(CANNED_BODY_MAX + 1)],
  ])('rechaza %s', (_caso, title, body) => {
    const r = crear(title, body);

    expect(r.isErr()).toBe(true);
    expect(error(r)).toBeInstanceOf(InvalidCannedResponseError);
  });

  it('el título de 80 y el cuerpo de 5000 son válidos', () => {
    const r = crear('x'.repeat(CANNED_TITLE_MAX), 'y'.repeat(CANNED_BODY_MAX));

    expect(r.isOk()).toBe(true);
  });

  it('rechaza una variable desconocida y la nombra en el mensaje', () => {
    const r = crear('Título', 'Hola {{x}}');

    expect(r.isErr()).toBe(true);
    expect(error(r).message).toContain('{{x}}');
  });

  it('reescribir cambia título, clave, cuerpo y fecha de edición', () => {
    const plantilla = valor(crear('Saludo', 'Hola'));

    const r = plantilla.rewrite({
      title: 'Despedida',
      body: 'Chau {{agente.email}}',
      now: DESPUES,
    });

    expect(r.isOk()).toBe(true);
    expect(plantilla.title).toBe('Despedida');
    expect(plantilla.titleKey).toBe('despedida');
    expect(plantilla.body).toBe('Chau {{agente.email}}');
    expect(plantilla.updatedAt).toEqual(DESPUES);
    expect(plantilla.createdAt).toEqual(AHORA);
  });

  it('una reescritura inválida no toca nada', () => {
    const plantilla = valor(crear('Saludo', 'Hola'));

    const r = plantilla.rewrite({ title: 'Otro', body: '{{', now: DESPUES });

    expect(r.isErr()).toBe(true);
    expect(plantilla.title).toBe('Saludo');
    expect(plantilla.body).toBe('Hola');
    expect(plantilla.updatedAt).toEqual(AHORA);
  });
});
