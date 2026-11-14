# Búsqueda — diseño

**Fecha:** 2026-11-13 · **Estado:** decisiones 6–8 aprobadas por el usuario (las
13 de etiquetas/búsqueda/vistas, 2026-11-12) · **Repos:** `helpdesk-api` +
`helpdesk-web` · **ADR:** 0032 · **Entrega 2 de 3** (después: vistas guardadas).

## Por qué

Hoy la bandeja solo filtra por estado, asignado, solicitante, IA y etiquetas.
Encontrar "el ticket del PDF en blanco" exige recorrer la lista. Lo que uno
recuerda suele estar en la conversación, no solo en el asunto.

## Decisiones aprobadas

6. **Qué busca:** asunto, descripción y comentarios. Las **notas internas solo
   para el equipo** (un cliente no puede adivinar el contenido de una nota
   buscando palabras). `#123` o `123` busca por número.
7. **Motor:** búsqueda de texto completo de **Postgres en español**, sin
   distinguir acentos, con prefijos ("fact" encuentra "factura"), índice GIN.
   Nada de Elasticsearch/Meilisearch: otro servicio que sacaría los datos de
   la protección de RLS.
8. **Orden:** la búsqueda es **un filtro más** (`?q=`) que se combina con los
   demás; el orden sigue siendo por fecha y la paginación por cursor no cambia.

## Diseño técnico (calls del asistente, verificados con una prueba descartable)

- **Columnas `search_vector` GENERADAS** (`GENERATED ALWAYS AS … STORED`) en
  `tickets` (asunto con peso A + descripción con peso B) y `comments` (cuerpo).
  Postgres las mantiene solas: no hay triggers ni código de la app que pueda
  olvidarse de actualizarlas. Índice GIN en cada una.
- **Acentos:** `unaccent` es STABLE y una columna generada exige IMMUTABLE →
  función envoltorio `helpdesk_unaccent(text)` que fija diccionario y esquema.
  `CREATE EXTENSION unaccent` funciona sin superusuario (extensión "trusted"
  desde PG13; vale para Neon).
- **Prisma sin drift:** las columnas van en el schema como
  `Unsupported("tsvector")?` con `@default(dbgenerated("<expresión exacta que
  devuelve Postgres>"))` y `@@index([searchVector], type: Gin)`. Probado:
  `migrate diff` vacío. Sin el `dbgenerated`, Prisma quiere hacer
  `DROP DEFAULT` para siempre.
- **Consulta:** el texto se parte en palabras (letras y números Unicode; el
  resto se descarta, así nunca llega sintaxis de `tsquery` del usuario), máx.
  8, cada una como prefijo, unidas con AND:
  `to_tsquery('spanish', helpdesk_unaccent('factura:* & octubre:*'))`. Sin
  palabras válidas → el filtro no aplica.
- **Predicado** (por ticket): `search_vector @@ q`, **o** `number = n` si el
  texto es `#n` o `n`, **o** existe un comentario del ticket con
  `search_vector @@ q` y visibilidad permitida al rol (`visibleTo`).
- **Integración con el listado (Prisma no admite `@@` en `where`):** una
  consulta SQL devuelve los ids que cumplen el predicado — las **1000
  coincidencias más recientes** — y el `findMany` de siempre los usa como
  `id IN (…)` junto con los demás filtros y el cursor. **Coste aceptado:** una
  búsqueda que coincide con más de 1000 tickets solo muestra los 1000 más
  recientes. Para encontrar un ticket concreto alcanza de sobra; la
  alternativa (toda la página en SQL a mano) duplicaría cada filtro existente.
- **RLS:** la consulta corre dentro de `withTenant` con el rol de aplicación,
  como todo; además filtra por `tenant_id`.

## Web

Caja de búsqueda en la bandeja (con un retardo de ~300 ms para no pedir en cada
tecla). `q` recortado entra en la clave de caché solo si no está vacío (regla
de las claves omitidas de `filtros.ts`). Disponible para todos los roles: el
backend decide qué comentarios cuentan.

## Fuera de alcance

Ordenar por relevancia, resaltar coincidencias, buscar por nombre de etiqueta,
búsqueda difusa por errores de tipeo (`pg_trgm`), operadores (`OR`, comillas).

## Restricciones

`migrate diff` vacío en BD desechable; RLS intacto; unit, e2e completos, lint,
typecheck; web tests, tsc, lint y build.
