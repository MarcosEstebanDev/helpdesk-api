# Etiquetas — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Catálogo de etiquetas por organización que el equipo asigna a tickets, filtra en la bandeja y ve en el historial; el cliente nunca las ve.

**Architecture:** Entidad `Tag` y función pura `diffTagSets` en el dominio de `ticketing`; dos puertos (`TagRepository`, `TicketTagRepository`); casos de uso de catálogo y `SetTicketTags`, que usa `Ticket.recordTagsChanged` para emitir `ticket.tags_changed` por el outbox (→ realtime, sala staff). El read model añade `tags` y el filtro `tagId` solo para el equipo. En el web: lozenges de color, editor en el detalle, filtro en la bandeja y `/settings/etiquetas`.

**Tech Stack:** NestJS 11, Prisma 6, Postgres 17 (RLS), Jest + supertest; Next.js, TanStack Query, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-12-etiquetas-design.md`

## Global Constraints

- Nombre: recortado, 1–40 caracteres; único por tenant sin distinguir mayúsculas (`name_key` = trim + lowercase).
- Colores: exactamente `gray, red, orange, yellow, green, teal, blue, purple`; por defecto `gray`.
- Máximo 10 etiquetas por ticket; `tagIds` duplicados se colapsan.
- Roles: `GET /tags`, `POST /tags`, `PUT /tickets/:id/tags` → AGENT; `PATCH`/`DELETE /tags/:id` → ADMIN. El VIEWER nunca recibe `tags` (clave omitida) y `tagId` en `GET /tickets` le da 403.
- Errores: 400 validación / más de 10; 404 ticket o etiqueta inexistente; 409 nombre duplicado o ticket CLOSED.
- `GET /tickets?tagId=` con ids inexistentes → 200 (sin validar contra el catálogo); máx. 10 `tagId`, todos UUID.
- Auditoría: `ticket.tags_changed` (`entityType 'ticket'`, `metadata {added:[{id,name}], removed:[{id,name}]}`), `tag.created|tag.updated|tag.deleted` (`entityType 'Tag'`). `PUT` sin cambios: sin auditoría ni evento.
- Evento `ticket.tags_changed` v1, payload `{ added: string[], removed: string[] }`, ruta `[REALTIME_QUEUE]`, audiencia `staff`.
- RLS ENABLE+FORCE+`tenant_isolation` en `tags` y `ticket_tags` (esta con `tenant_id` propio); `migrate diff` vacío en BD desechable; generar el SQL ANTES de crear la carpeta de la migración (gotcha P3015).
- Commits con `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; archivos CRLF (Edit o Python en modo texto con anclas verificadas).

## Review Focus

1. Un VIEWER que pide `GET /tickets/:id` de un ticket etiquetado → la respuesta no tiene clave `tags`. (e2e Task 5.)
2. `PUT /tickets/:id/tags` con 11 ids, o con un id de OTRA organización → 400 / 404 y el conjunto no cambia. (unit Task 3 + e2e Task 5.)
3. Borrar una etiqueta del catálogo con tickets que la usan → desaparece de esos tickets y el historial sigue mostrando su nombre. (e2e Task 5.)
4. Renombrar `Bug` → `bug` (solo mayúsculas) en la misma etiqueta → no es 409. (unit Task 2.)
5. Filtro `?tagId=A&tagId=B` → tickets con A o B, sin duplicados en la página. (e2e Task 5.)

---

### Task 1: Dominio — `Tag`, `diffTagSets`, evento y errores

**Files:** Create `domain/tag/tag.entity.ts`, `domain/tag/tag-set.ts`, `domain/tag/tag.spec.ts`; Modify `domain/ids.ts` (`TagId`), `domain/errors.ts` (`InvalidTagError` `ticketing.invalid_tag`, `TagNotFoundError` `ticketing.tag_not_found`, `DuplicateTagNameError` `ticketing.duplicate_tag_name`, `TooManyTagsError` `ticketing.too_many_tags`; unión), `domain/entities/audit-log.entity.ts` (4 acciones), `domain/events/ticketing.events.ts` (`TicketTagsChanged` + unión), `domain/entities/ticket.entity.ts` (`recordTagsChanged`) y su spec. (Rutas relativas a `src/modules/ticketing/`.)

**Interfaces — Produces:**
- `TAG_COLORS` (const tupla de 8), `type TagColor`, `isTagColor(v): v is TagColor`, `TAG_NAME_MAX = 40`, `MAX_TAGS_PER_TICKET = 10`, `canonicalTagKey(name): string`.
- `class Tag extends Entity<TagId>`: getters `tenantId, name, nameKey, color, createdAt, updatedAt`; `static create({id, tenantId, name, color?, now}): Result<Tag, InvalidTagError>`; `rename(name, now)`, `recolor(color, now)` → `Result<void, InvalidTagError>`; `static rehydrate`.
- `diffTagSets(current: TagId[], desired: TagId[]): Result<{ next: TagId[]; added: TagId[]; removed: TagId[] }, TooManyTagsError>` — `desired` deduplicado en orden de aparición; `added` en orden de `desired`, `removed` en orden de `current`.
- `Ticket.recordTagsChanged(added: TagId[], removed: TagId[], now): void` — no-op si ambos vacíos; si no, `updatedAt = now` y emite `TicketTagsChanged`.

- [ ] **Step 1: Tests que fallan** (`tag.spec.ts` + `ticket.entity.spec.ts`): `create` recorta y calcula `nameKey`; vacío / 41 caracteres / color `pink` → `InvalidTagError`; color por defecto `gray`; `rename` inválido no muta; `diffTagSets([a,b],[b,c,c])` → `{next:[b,c], added:[c], removed:[a]}`; iguales → added/removed vacíos; 11 distintos → `TooManyTagsError`; `recordTagsChanged([],[])` no emite; con cambios emite un evento `ticket.tags_changed` con los ids y actualiza `updatedAt`.
- [ ] **Step 2:** `corepack pnpm test -- tag.spec ticket.entity` → FAIL. **Step 3:** implementar. **Step 4:** PASS + `corepack pnpm typecheck`.
- [ ] **Step 5: Commit** `feat(ticketing): dominio de etiquetas`.

### Task 2: Catálogo — puerto, doble y casos de uso

**Files:** Create `domain/ports/tag.repository.ts`, `application/tags/{create,update,delete,list}-tag.use-case.ts`, `application/tags/tags.spec.ts`; Modify `application/ticketing.test-doubles.ts` (`fakeTags()` con copias, como `fakeCannedResponses`).

**Interfaces — Produces:**
- `TagRepository { list(tenantId): Promise<Tag[]> /* por name_key */; findById(tenantId, id); findByIds(tenantId, ids: TagId[]): Promise<Tag[]>; existsNameKey(tenantId, nameKey, exceptId?): Promise<boolean>; insert(t); update(t); remove(tenantId, id): Promise<boolean> }`, `TAG_REPOSITORY`.
- `CreateTag(transactions, tags, audit, ids, clock).execute({tenantId, actorId, name, color?})` → `Result<Tag, TicketingError>`; audita `tag.created` `{name, color}`.
- `UpdateTag(transactions, tags, audit, clock).execute({tenantId, actorId, id, name?, color?})`; audita `tag.updated` `{before:{name,color}, after:{name,color}}`; sin cambios → ok sin auditar.
- `DeleteTag(...)` audita `tag.deleted` `{name, color}`; si `remove` devuelve false → `TagNotFoundError`.
- `ListTags(tags).execute({tenantId})`.

- [ ] **Step 1: Tests:** crear + auditoría; duplicado sin distinguir mayúsculas → 409-error sin auditoría; **renombrar `Bug`→`bug` en la misma etiqueta NO es duplicado** (Review Focus 4); renombrar a un nombre de OTRA → duplicado; color inválido → `InvalidTagError`; update/delete de inexistente → `TagNotFoundError`; list ordenado.
- [ ] **Step 2:** FAIL. **Step 3:** implementar (patrón de `canned-responses`). **Step 4:** PASS + typecheck. **Step 5: Commit** `feat(ticketing): catálogo de etiquetas`.

### Task 3: `SetTicketTags`

**Files:** Create `domain/ports/ticket-tag.repository.ts`, `application/tags/set-ticket-tags.use-case.ts`; Modify `tags.spec.ts`, test-doubles (`fakeTicketTags()`).

**Interfaces — Produces:** `TicketTagRepository { tagsOf(tenantId, ticketId): Promise<TagId[]>; replace(tenantId, ticketId, tagIds: TagId[]): Promise<void> }`, `TICKET_TAG_REPOSITORY`; `SetTicketTags(transactions, tickets, tags: TagRepository, ticketTags, audit, events: EventRecorder, clock).execute({tenantId, actorId, ticketId, tagIds}) → Result<Tag[], TicketingError>` (las etiquetas resultantes, por nombre).

- [ ] **Step 1: Tests:** reemplaza y audita `ticket.tags_changed` con `{added:[{id,name}], removed:[{id,name}]}` y registra UN evento en el outbox; sin cambios → ok, sin auditoría ni evento; 11 ids → `TooManyTagsError` sin tocar nada (Review Focus 2); id inexistente (u otro tenant) → `TagNotFoundError` sin tocar nada; ticket inexistente → `TicketNotFoundError`; ticket CLOSED → `TicketClosedError`.
- [ ] **Step 2:** FAIL. **Step 3:** implementar: `findById` ticket → si CLOSED err → `findByIds` (si `length` ≠ ids únicos → not found) → `tagsOf` → `diffTagSets` → si cambios: `replace`, `ticket.recordTagsChanged`, `tickets.save`, `audit.record`, `events.record(ticket)`. **Step 4:** PASS + typecheck. **Step 5: Commit** `feat(ticketing): etiquetar tickets`.

### Task 4: Persistencia y read model

**Files:** Modify `prisma/schema.prisma` (`Tag`, `TicketTag` con PK `(ticketId, tagId)`, `tenantId`, FKs cascade a ticket, tag y organización; `@@unique([tenantId, nameKey])`; `@@index([tenantId, tagId])` en `TicketTag`); Create `prisma/migrations/20261112140000_tags/migration.sql` (SQL generado + bloque RLS/GRANT para las DOS tablas), `infrastructure/persistence/prisma-tag.repository.ts`, `prisma-ticket-tag.repository.ts`; Modify `infrastructure/persistence/ticket.read-model.ts`.

**Interfaces — Produces:** read model `list(tenantId, { …, withTags?: boolean, tagIds?: string[] })` y `detail(..., { withTags })`: con `withTags` cada ticket trae `tags: {id,name,color}[]` ordenadas por `nameKey`; `tagIds` filtra con `tags: { some: { tagId: { in } } }`.

- [ ] **Step 1:** Generar el SQL con `migrate diff --from-migrations … --shadow-database-url <BD desechable> --script` (SIN crear antes la carpeta), crear la carpeta y el archivo, añadir RLS + GRANT a mano.
- [ ] **Step 2:** Validar en BD desechable: `migrate deploy`, `migrate diff --exit-code` → `No difference detected.`, `relrowsecurity/relforcerowsecurity` = `t|t` en las dos tablas; borrar la BD. Luego `prisma:deploy` en dev + `prisma generate`.
- [ ] **Step 3:** Repos (`replace` = `deleteMany` + `createMany` dentro de `runInTenant`) y read model.
- [ ] **Step 4:** typecheck (el e2e de Task 5 es la prueba real). **Step 5: Commit** `feat(ticketing): tablas de etiquetas con RLS`.

### Task 5: HTTP, wiring, realtime y e2e

**Files:** Create `infrastructure/http/tag.controller.ts`, `dto/tag.dto.ts`, `test/tags.e2e-spec.ts`; Modify `ticket.controller.ts` (`PUT :id/tags`, `tagId` en el listado, `tags` en list/detail solo equipo), `dto/ticket.dto.ts` (`tagId?: string[]` con `@Transform` a array, `@IsUUID('all',{each:true})`, `@ArrayMaxSize(10)`; `tags?` opcional en `TicketDetailDto` y `TicketListItemDto`), `ticketing-http.mapper.ts` (4 códigos), `ticketing.module.ts`, `src/infrastructure/queue/queues.ts` (`'ticket.tags_changed': [REALTIME_QUEUE]`), `application/realtime/broadcast-ticket-event.use-case.ts` (+ spec: audiencia staff, payload `{...base, added, removed}`).

- [ ] **Step 1: e2e que falla** (`tags.e2e-spec.ts`, andamiaje de `canned-responses.e2e-spec.ts`, ADMIN/AGENT/VIEWER + otra organización): AGENT crea etiqueta (201), duplicada con otras mayúsculas (409); AGENT etiqueta un ticket (PUT 200) y lo ve en `GET /tickets/:id` y en el listado; **VIEWER: `GET /tickets/:id` sin clave `tags`** (Review Focus 1) y `GET /tickets?tagId=` → 403; 11 ids → 400; id de otra org → 404 y el conjunto no cambió (Review Focus 2); **filtro `?tagId=A&tagId=B`** → incluye tickets con A o B, cada uno una vez (Review Focus 5); `tagId` inexistente → 200 vacío; ticket CLOSED → 409; AGENT `PATCH`/`DELETE` → 403; ADMIN borra una etiqueta usada → desaparece del ticket y el historial (`GET /tickets/:id/history`) conserva la entrada `ticket.tags_changed` con su nombre (Review Focus 3); el outbox tiene un `ticket.tags_changed`.
- [ ] **Step 2:** sin `start:dev` arriba, `corepack pnpm test:e2e -- tags` → FAIL (404). **Step 3:** implementar. **Step 4:** e2e PASS + `pnpm test`, `typecheck`, `lint:ci`. **Step 5: Commit** `feat(ticketing): endpoints de etiquetas`.

### Task 6: Docs y seed

**Files:** `docs/ARCHITECTURE.md` (ADR-0031 + índice), `README.md` (endpoints), `CLAUDE.md` (decisión locked + estado), `src/seed.ts` (etiquetas `facturación` green, `bug` red, `vip` purple; asignar 1–2 a algunos tickets por `SetTicketTags`).

- [ ] **Step 1–2:** escribir. **Step 3:** correr el seed en BD desechable (como en ADR-0030) y comprobar filas. **Step 4:** typecheck + lint:ci. **Step 5: Commit** `docs: ADR-0031 etiquetas (+ seed)`.

### Task 7 (web): datos, colores, realtime e historial

**Files (`helpdesk-web`):** `src/lib/api/types.ts` (`Tag`, `TagColor`, `tags?` en `TicketDetail`/`TicketListItem`, `tagId` en filtros), `src/lib/query/keys.ts` (`tagKeys`), `src/features/tags/{api,queries}.ts`, `src/features/tags/components/tag-lozenge.tsx` (+ test: un color por clase, contraste en claro/oscuro con tokens), `src/lib/realtime/events.ts` + `src/providers/ws-provider.tsx` (`ticket.tags_changed` invalida detalle y listas), `src/features/tickets/audit.ts` (+ test: "Agregó la etiqueta X", "Quitó las etiquetas X e Y", mixto).

- [ ] TDD por archivo; `corepack pnpm test`, `tsc --noEmit`. **Commit** `feat(etiquetas): datos, colores, realtime e historial`.

### Task 8 (web): editor en el detalle, lozenges y filtro en la bandeja

**Files:** `src/features/tags/components/tag-editor.tsx` (+ test), `src/app/(app)/tickets/[id]/page.tsx`, `src/app/(app)/tickets/page.tsx`, `src/features/tickets/filters.ts` (+ test: `tagIds` vacío se OMITE de la clave).

- [ ] **Tests:** el editor solo aparece para el equipo; autocompleta del catálogo; "Crear «x»" si no existe (POST y después PUT con el id nuevo); quitar con la X; un error 400 del máximo se muestra. La bandeja pinta lozenges (equipo) y el filtro multi-selección manda `tagId` repetido.
- [ ] `corepack pnpm test`, tsc, lint. **Commit** `feat(etiquetas): editor, lozenges y filtro`.

### Task 9 (web): `/settings/etiquetas`, nav y docs

**Files:** `src/app/(app)/settings/etiquetas/{layout,page,page.test}.tsx`, `src/app/(app)/layout.tsx` (nav `Tags`, `soloAdmin`), `CLAUDE.md`.

- [ ] **Tests:** solo ADMIN; renombrar; cambiar color; borrar con confirmación en la fila que avisa "se quita de N… de todos los tickets"; 409 → "Ya hay una etiqueta con ese nombre."
- [ ] `corepack pnpm test`, tsc, lint, **build**. **Commit** `feat(etiquetas): configuración de etiquetas`.

## Verificación final

api: unit, typecheck, lint:ci, `test:e2e` completo. Web: tests, tsc, lint, build. Revisor fresco (opus) sobre los dos repos con este Review Focus. Preguntar antes de mergear a `dev`.
