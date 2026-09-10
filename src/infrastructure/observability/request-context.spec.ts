import {
  REQUEST_ID_MAX_LENGTH,
  getContextTenantId,
  getRequestId,
  runWithRequestId,
  sanitizeRequestId,
} from './request-context';

describe('sanitizeRequestId', () => {
  it('acepta un identificador normal', () => {
    expect(sanitizeRequestId('abc-123_XYZ.4:5')).toBe('abc-123_XYZ.4:5');
  });

  it('recorta un id descomunal en vez de rechazarlo', () => {
    // El valor lo elige el CLIENTE y acaba en cada línea de log de la petición:
    // sin tope, una cabecera de un megabyte infla el volumen de logs a voluntad.
    // Se recorta en vez de descartarlo para no perder la correlación entrante.
    const enorme = 'a'.repeat(REQUEST_ID_MAX_LENGTH + 500);

    expect(sanitizeRequestId(enorme)).toHaveLength(REQUEST_ID_MAX_LENGTH);
  });

  it('rechaza un id con saltos de línea', () => {
    // Un salto de línea en un log de texto plano permite inyectar entradas
    // falsas: alguien podría fabricar una línea que parezca del sistema.
    expect(sanitizeRequestId('abc\ndef')).toBeNull();
    expect(sanitizeRequestId('abc\r\nINFO: todo bien')).toBeNull();
  });

  it('rechaza espacios y caracteres raros', () => {
    expect(sanitizeRequestId('con espacios')).toBeNull();
    expect(sanitizeRequestId('{"json":true}')).toBeNull();
    expect(sanitizeRequestId('')).toBeNull();
  });

  it('rechaza lo que no sea texto', () => {
    // Las cabeceras repetidas llegan como array; no se elige una al azar.
    expect(sanitizeRequestId(['a', 'b'])).toBeNull();
    expect(sanitizeRequestId(undefined)).toBeNull();
    expect(sanitizeRequestId(42)).toBeNull();
  });
});

describe('contexto de correlación', () => {
  it('fuera de una unidad de trabajo no hay contexto', () => {
    expect(getRequestId()).toBeNull();
    expect(getContextTenantId()).toBeNull();
  });

  it('sobrevive a los saltos asíncronos', async () => {
    // Es toda la razón de usar AsyncLocalStorage: el id tiene que seguir ahí
    // después de un await, dentro de un caso de uso que nadie ha instrumentado.
    const visto = await runWithRequestId('traza-1', async () => {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 1));
      return getRequestId();
    });

    expect(visto).toBe('traza-1');
  });

  it('cada unidad de trabajo tiene el suyo, sin filtrarse', () => {
    const primera = runWithRequestId('a', () => getRequestId());
    const segunda = runWithRequestId('b', () => getRequestId());

    expect(primera).toBe('a');
    expect(segunda).toBe('b');
    expect(getRequestId()).toBeNull();
  });

  it('el tenant del contexto es opcional', () => {
    expect(runWithRequestId('a', () => getContextTenantId())).toBeNull();
    expect(runWithRequestId('a', () => getContextTenantId(), 't-1')).toBe(
      't-1',
    );
  });
});
