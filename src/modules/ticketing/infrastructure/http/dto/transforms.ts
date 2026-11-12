import { Transform } from 'class-transformer';

/**
 * Recorta los bordes ANTES de que `class-validator` mida el largo. El dominio
 * recorta igual, y sin esto un texto que solo pasaba del máximo por sus
 * espacios recibía un 400 que el dominio no habría dado.
 */
export const Trim = () =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  );

/**
 * Ids en minúsculas. Postgres compara los `uuid` sin mirar mayúsculas, pero el
 * código que los cruza en memoria (un `Map`, un `Set`) no: un id en mayúsculas
 * de una etiqueta existente daba 404. Acepta un string suelto o un array.
 */
export const LowercaseIds = () =>
  Transform(({ value }: { value: unknown }) => {
    const aMinuscula = (v: unknown) =>
      typeof v === 'string' ? v.toLowerCase() : v;
    if (typeof value === 'string') return [aMinuscula(value)];
    return Array.isArray(value) ? value.map(aMinuscula) : value;
  });
