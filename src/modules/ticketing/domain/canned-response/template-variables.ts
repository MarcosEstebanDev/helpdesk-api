/**
 * Variables que una respuesta predefinida puede usar (ADR-0030).
 *
 * Es una lista CERRADA: una variable mal escrita (`{{clinete.email}}`) que se
 * guardara sin error llegaría literal al cliente, porque el front solo rellena
 * las que conoce. Por eso la plantilla se valida al GUARDARLA, no al usarla.
 *
 * El front repite esta misma regla para avisar al agente de que quedó algo sin
 * rellenar (repos separados, ADR-0001): si cambia aquí, cambia allí.
 */
export const TEMPLATE_VARIABLES = [
  'ticket.numero',
  'ticket.asunto',
  'cliente.email',
  'agente.email',
] as const;

export type TemplateVariable = (typeof TEMPLATE_VARIABLES)[number];

/**
 * Una variable válida, con espacio interno tolerado. El lookbehind y el
 * lookahead hacen que `{{{ticket.numero}}}` NO cuente: con llaves triples, una
 * de ellas llegaría literal al cliente.
 */
export const VALID_PLACEHOLDER =
  /(?<!\{)\{\{\s*(ticket\.numero|ticket\.asunto|cliente\.email|agente\.email)\s*\}\}(?!\})/g;

/** Lo que queda mal después de quitar las válidas: `{{algo}}` o una llave suelta. */
const LEFTOVER = /\{\{[^{}]*\}\}|\{\{|\}\}/;

/**
 * Devuelve el primer fragmento que no es una variable válida, o `null` si el
 * texto está limpio. Las llaves simples (`{a: 1}`) se permiten: solo las dobles
 * tienen significado aquí.
 */
export const findInvalidPlaceholder = (body: string): string | null => {
  const resto = body.replace(VALID_PLACEHOLDER, '');
  return LEFTOVER.exec(resto)?.[0] ?? null;
};
