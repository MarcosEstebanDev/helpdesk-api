/**
 * Traducción del texto de búsqueda a una `tsquery` de Postgres (ADR-0032).
 *
 * Vive en el dominio porque decide QUÉ significa buscar: cada palabra es un
 * prefijo ("fact" encuentra "factura") y todas tienen que aparecer. El texto
 * se reduce a palabras de letras y números; cualquier otro carácter se
 * descarta, así la sintaxis de `tsquery` (`&`, `|`, `!`, `:*`, paréntesis) no
 * puede llegar desde el usuario y una búsqueda rara nunca es un 500.
 *
 * Los acentos se dejan: los quita `helpdesk_unaccent` en SQL, igual que al
 * indexar, para que la regla viva en un solo lugar. Por eso esto devuelve
 * PALABRAS y no la `tsquery` armada: algunas letras, al quitarles el acento,
 * se convierten en sintaxis (`ʼ` → `'`, `⑴` → `(1)`), así que SQL las vuelve
 * a filtrar después de `unaccent`, palabra por palabra (revisión final).
 */

export const SEARCH_MAX_TERMS = 8;

/** Mayor `int4` de Postgres: un `number` más grande haría fallar la consulta. */
const INT4_MAX = 2_147_483_647;

export interface ParsedSearch {
  /** Palabras (cada una será un prefijo, todas obligatorias). Vacío = no filtra. */
  terms: string[];
  /** `#123` o `123` buscan además el ticket con ese número. */
  number: number | null;
}

export const parseSearch = (raw: string): ParsedSearch => {
  const texto = raw.trim().toLowerCase();
  const palabras = (texto.match(/[\p{L}\p{N}]+/gu) ?? []).slice(
    0,
    SEARCH_MAX_TERMS,
  );

  const soloNumero = /^#?(\d+)$/.exec(texto);
  const numero = soloNumero === null ? null : Number(soloNumero[1]);

  return {
    terms: palabras,
    number: numero !== null && numero <= INT4_MAX ? numero : null,
  };
};
