import { aVistasDeEtiquetas } from './tag-view';

const fila = (id: string, name: string, color: string) => ({
  tag: { id, name, nameKey: name.toLowerCase(), color },
});

describe('aVistasDeEtiquetas (ADR-0031)', () => {
  it('ordena por nombre sin distinguir mayúsculas', () => {
    const vistas = aVistasDeEtiquetas([
      fila('2', 'vip', 'purple'),
      fila('1', 'Bug', 'red'),
    ]);

    expect(vistas.map((v) => v.name)).toEqual(['Bug', 'vip']);
  });

  it('un color fuera de la paleta (UPDATE a mano) se muestra gris', () => {
    const [vista] = aVistasDeEtiquetas([fila('1', 'rara', 'fucsia')]);

    expect(vista).toEqual({ id: '1', name: 'rara', color: 'gray' });
  });
});
