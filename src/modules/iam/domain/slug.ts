// Combining diacritical marks (U+0300–U+036F): se eliminan tras NFKD para sacar
// acentos. Se usa RegExp con escapes para no incrustar caracteres invisibles.
const COMBINING_MARKS = new RegExp('[\\u0300-\\u036f]', 'g');

/**
 * Convierte el nombre de una organización en un slug url-safe y estable, que
 * además sirve como discriminador de tenant en el login (`/auth/login`).
 */
export const slugify = (name: string): string =>
  name
    .normalize('NFKD')
    .replace(COMBINING_MARKS, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-') // no alfanumérico -> guion
    .replace(/^-+|-+$/g, '') // sin guiones en los bordes
    .slice(0, 50);
