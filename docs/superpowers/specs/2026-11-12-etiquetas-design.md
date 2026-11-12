# Etiquetas — diseño

**Fecha:** 2026-11-12 · **Estado:** decisiones 1–5 y 12 aprobadas por el usuario
en chat (las 13 de etiquetas/búsqueda/vistas) · **Repos:** `helpdesk-api` +
`helpdesk-web` · **ADR:** 0031 (nuevo) · **Entrega 1 de 3** (después: búsqueda
ADR-0032, vistas guardadas ADR-0033).

## Por qué

Tanda 1 de producto. El equipo necesita clasificar tickets con criterios
propios ("facturación", "bug", "cliente VIP") para encontrarlos y repartirlos.
Es además lo que las vistas guardadas (entrega 3) van a filtrar.

## Decisiones aprobadas

1. **Catálogo por organización** (`tags`) + relación `ticket_tags`. Renombrar no
   toca tickets; colores; sin variantes por typo.
2. **El agente etiqueta y crea etiquetas al vuelo**; el **ADMIN** renombra,
   cambia color y borra.
3. **Solo el equipo las ve.** El VIEWER no recibe etiquetas en ninguna
   respuesta ni en tiempo real, y no puede filtrar por ellas.
4. **Formato:** nombre recortado de 1–40 caracteres, único por organización sin
   distinguir mayúsculas (`name_key`, mismo patrón que `title_key` del
   ADR-0030); color de una **paleta fija de 8**: `gray`, `red`, `orange`,
   `yellow`, `green`, `teal`, `blue`, `purple` (por defecto `gray`).
5. **Rastro:** agregar/quitar etiquetas de un ticket queda en su historial y se
   avisa en vivo SOLO a la sala del equipo.
12. **Filtro de la bandeja:** "tiene al menos una de" estas etiquetas.

## Contrato HTTP (call del asistente)

| Método | Ruta | Rol mín. | Qué hace |
|---|---|---|---|
| `GET` | `/tags` | AGENT | `{ items: Tag[] }` por nombre |
| `POST` | `/tags` | AGENT | crea `{ name, color? }` → 201 `Tag`; nombre repetido → 409 |
| `PATCH` | `/tags/:id` | ADMIN | `{ name?, color? }` → 200 `Tag` |
| `DELETE` | `/tags/:id` | ADMIN | 204; la quita de todos los tickets (cascada) |
| `PUT` | `/tickets/:id/tags` | AGENT | `{ tagIds: string[] }` reemplaza el conjunto → 200 `{ tags: Tag[] }` |

`Tag = { id, name, color }`.

- `GET /tickets` acepta `tagId` repetible (`?tagId=a&tagId=b`, máx. 10):
  tickets con al menos una. Un VIEWER que lo mande → 403 (mismo criterio que
  `aiSuggestsHigher`).
- `GET /tickets` y `GET /tickets/:id` devuelven `tags: Tag[]` a AGENT+; al
  VIEWER el campo **no viaja** (se omite, no `[]`, para no insinuar nada).

## Reglas

- **Máximo 10 etiquetas por ticket** (400 si se excede). `tagIds` duplicados se
  colapsan. Un id que no existe en la organización → 404 (no se crea nada).
- **Ticket CERRADO no se re-etiqueta** (409, `ticketing.ticket_closed`): CLOSED
  es terminal (ADR-0015), igual que comentar.
- `PUT` sin cambios efectivos: 200, sin auditoría ni evento.
- Auditoría en el ticket: acción `ticket.tags_changed`, `entityType 'ticket'`,
  `metadata: { added: [{id,name}], removed: [{id,name}] }` (los NOMBRES viajan
  para que el historial se lea aunque la etiqueta se borre después).
- Auditoría del catálogo: `tag.created | tag.updated | tag.deleted`,
  `entityType 'Tag'`.
- Evento de integración `ticket.tags_changed` v1 emitido por el AGREGADO
  (`Ticket.recordTagsChanged(added, removed, now)`, que además actualiza
  `updatedAt`), payload `{ added: string[], removed: string[] }` (ids). Ruta:
  cola `realtime` → audiencia `staff`.
- Renombrar/borrar una etiqueta del catálogo no emite eventos por ticket (sería
  una tormenta); el front invalida su caché de tags y de tickets al hacerlo.

## Calls tras la revisión del diseño (del asistente)

- **Relación con búsqueda y vistas:** la búsqueda (decisión 6) NO busca por
  nombre de etiqueta. Las vistas (entrega 3) guardan `tagIds`; nada de esta
  entrega se rehace después.
- **Filtro con una etiqueta inexistente o borrada:** va directo al `WHERE`, sin
  validar contra el catálogo → 200 con lo que coincida (nada, si ninguna existe).
  Así una vista guardada que apunta a una etiqueta borrada no queda rota. Los
  ids sí se validan como UUID (400 si no lo son).
- **Las etiquetas NO son estado del agregado `Ticket`:** viven en su propio
  puerto `TicketTagRepository` (`tagsOf(tenantId, ticketId)` y
  `replace(tenantId, ticketId, tagIds)`). Las reglas de conjunto viven en una
  función PURA del dominio, `diffTagSets(current: TagId[], desired: TagId[])`
  → `Result<{ next, added, removed }, TooManyTagsError>` (deduplica, máx. 10,
  añadidos/quitados en orden estable). El caso de uso carga el ticket (404 /
  CLOSED → 409), valida que los ids existan, aplica el diff y, si hubo cambios,
  llama a `ticket.recordTagsChanged(added, removed, now)`, que actualiza
  `updatedAt` y emite el evento; luego guarda el ticket (outbox) y audita, todo
  en la misma transacción.
- **Concurrencia:** dos agentes guardando a la vez → **gana el último**. No se
  bloquea la fila del ticket. Coste aceptado: en esa carrera de milisegundos el
  `added/removed` auditado puede no coincidir exactamente con lo que vio cada
  uno; el conjunto final siempre es el del último `PUT`.
- **Historial:** muestra el nombre que la etiqueta tenía en ese momento (el de
  `metadata`), aunque después se haya renombrado o borrado.

## Web

- Detalle del ticket (solo equipo): bloque "Etiquetas" en el panel lateral con
  las lozenges de color y un editor con autocompletado del catálogo; si lo
  escrito no existe, ofrece "Crear «x»" (POST + PUT).
- Bandeja: lozenges en cada fila (equipo) y un filtro por etiquetas
  (multi-selección, "al menos una").
- Historial: "Agregó la etiqueta X" / "Quitó la etiqueta Y".
- `/settings/etiquetas` (ADMIN): renombrar, color, borrar (confirmación en la
  fila; avisa que se quita de todos los tickets).
- Realtime: `ticket.tags_changed` invalida el detalle y las listas.

## No-objetivos

Etiquetas visibles para el cliente; etiquetas automáticas por reglas (tanda 3);
contadores de uso; jerarquías o grupos de etiquetas; filtro "tiene todas".

## Restricciones

Hexagonal, `Result`, branded `TagId`; RLS ENABLE+FORCE+`tenant_isolation` en
las dos tablas nuevas (`ticket_tags` lleva `tenant_id` propio para la policy);
`migrate diff` vacío validado en BD desechable; typecheck, lint:ci, unit, e2e
completos verdes; web tests, tsc, lint y build verdes.
