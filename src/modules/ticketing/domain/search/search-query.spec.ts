import { SEARCH_MAX_TERMS, parseSearch } from './search-query';

describe('parseSearch (ADR-0032)', () => {
  it('separa las palabras en minúsculas', () => {
    expect(parseSearch('Factura Octubre')).toEqual({
      terms: ['factura', 'octubre'],
      number: null,
    });
  });

  it('deja los acentos: los quita SQL, igual que al indexar', () => {
    expect(parseSearch('Facturación').terms).toEqual(['facturación']);
  });

  it('descarta la sintaxis de tsquery: nunca llega al motor', () => {
    expect(parseSearch('a & | ! (b) :* \'c\' "d"').terms).toEqual([
      'a',
      'b',
      'c',
      'd',
    ]);
  });

  it.each(['', '   ', '!!! &&& ()'])(
    'sin palabras válidas no filtra (%p)',
    (raw) => {
      expect(parseSearch(raw)).toEqual({ terms: [], number: null });
    },
  );

  it('#123 y 123 buscan también por número', () => {
    expect(parseSearch('#123')).toEqual({ terms: ['123'], number: 123 });
    expect(parseSearch(' 123 ')).toEqual({ terms: ['123'], number: 123 });
  });

  it('algo que no es solo un número no busca por número', () => {
    expect(parseSearch('#12a').number).toBeNull();
    expect(parseSearch('ticket 12').number).toBeNull();
  });

  it('un número fuera de rango no busca por número (no rompe el int4)', () => {
    expect(parseSearch('99999999999999').number).toBeNull();
  });

  it(`como mucho ${SEARCH_MAX_TERMS} palabras`, () => {
    expect(parseSearch('a b c d e f g h i j').terms).toHaveLength(
      SEARCH_MAX_TERMS,
    );
  });
});
