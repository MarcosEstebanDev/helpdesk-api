import { runWithJobContext } from './job-context';
import { getContextTenantId, getRequestId } from './request-context';

const TENANT = '11111111-1111-1111-1111-111111111111';

describe('runWithJobContext', () => {
  it('hereda la correlación de la petición que originó el evento', () => {
    // Es LO que hace observable un sistema event-driven: buscar un requestId y
    // encontrar también lo que pasó de forma asíncrona por su culpa.
    const visto = runWithJobContext('traza-http', TENANT, () => getRequestId());

    expect(visto).toBe('traza-http');
  });

  it('inventa una correlación si el evento no traía ninguna', () => {
    // Pasa con lo que nace fuera de una petición (el barrido de SLA) y con lo
    // escrito antes de esta fase. El job sigue mereciendo poder seguirse de
    // principio a fin, aunque no se pueda enlazar hacia atrás.
    const visto = runWithJobContext(null, TENANT, () => getRequestId());

    expect(visto).not.toBeNull();
    expect(visto).toHaveLength(36); // uuid v4
  });

  it('no se fía de la correlación que viene en el evento', () => {
    // El `requestId` entró un día por una cabecera que eligió un cliente y se
    // guardó en la base de datos. Al restaurarlo se vuelve a validar: si no,
    // bastaría con crear un ticket con una cabecera envenenada para que el
    // worker escribiera lo que fuera en sus logs, horas después.
    const visto = runWithJobContext('malo\nINFO: falso', TENANT, () =>
      getRequestId(),
    );

    expect(visto).not.toContain('\n');
    expect(visto).toHaveLength(36);
  });

  it('deja el tenant disponible para los logs', () => {
    const visto = runWithJobContext('t', TENANT, () => getContextTenantId());

    expect(visto).toBe(TENANT);
  });
});
