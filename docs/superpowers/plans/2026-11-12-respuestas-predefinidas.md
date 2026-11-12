# Respuestas predefinidas — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Plantillas de texto compartidas por organización que el ADMIN mantiene y el agente inserta (rellenadas) en la caja de respuesta del ticket.

**Architecture:** Agregado nuevo `CannedResponse` dentro del bounded context `ticketing` (dominio puro con la validación de variables), tres casos de uso transaccionales con auditoría, un caso de lectura, repo Prisma con RLS y un controller propio. El relleno de variables es del front: una función pura con la misma regla de llaves que el dominio, un selector en el editor del ticket y una página de configuración para ADMIN.

**Tech Stack:** NestJS 11, Prisma 6, Postgres 17 (RLS), Jest + supertest; Next.js App Router, TanStack Query, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-11-12-respuestas-predefinidas-design.md`

## Global Constraints

- Variables válidas, exactas y sensibles a mayúsculas: `ticket.numero`, `ticket.asunto`, `cliente.email`, `agente.email`; espacio interno tolerado (`{{ ticket.numero }}`).
- Regla de llaves: tras quitar las variables válidas no puede quedar ningún `{{` ni `}}`.
- Título: recortado, 1–80 caracteres, único por tenant sin distinguir mayúsculas (`title_key` = recortado + minúsculas). Cuerpo: recortado no vacío, ≤ 5000 caracteres.
- Roles: `GET` AGENT; `POST`/`PUT`/`DELETE` ADMIN. VIEWER → 403.
- Errores: 400 validación, 404 inexistente/otro tenant, 409 título duplicado.
- Auditoría `canned_response.created|updated|deleted`, `entityType: 'CannedResponse'`, `entityId` = id; misma transacción.
- RLS ENABLE + FORCE + `tenant_isolation` fail-closed + GRANT a `helpdesk_app`.
- Sin evento de outbox ni realtime.
- `migrate diff` vacío (validado en BD desechable, nunca `migrate reset`).
- Commits terminan con `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Archivos en CRLF: editar con la herramienta Edit.
- UI en español rioplatense.

## Review Focus

1. Cuerpo con una llave suelta (`Hola {{ticket.numero`) → 400 al guardar, nunca llega al cliente. (Test en Task 1 y Task 7.)
2. Asunto del ticket que contiene `{{cliente.email}}` → se inserta literal, sin segunda pasada. (Test en Task 7.)
3. Insertar con texto ya escrito y el cursor en el medio → no se pierde nada. (Test en Task 8.)
4. Sesión restaurada por refresh → `{{agente.email}}` se rellena (no queda vacío). (Test en Task 9.)
5. Editar una plantilla cambiando solo mayúsculas del título (`Saludo` → `saludo`) → NO es 409 contra sí misma. (Test en Task 3.)

---

### Task 1: Dominio — `CannedResponse` y la regla de variables

**Files:**
- Create: `src/modules/ticketing/domain/canned-response/canned-response.entity.ts`
- Create: `src/modules/ticketing/domain/canned-response/template-variables.ts`
- Create: `src/modules/ticketing/domain/canned-response/canned-response.entity.spec.ts`
- Modify: `src/modules/ticketing/domain/ids.ts` (añadir `CannedResponseId`)
- Modify: `src/modules/ticketing/domain/errors.ts` (3 errores + unión `TicketingError`)
- Modify: `src/modules/ticketing/domain/entities/audit-log.entity.ts` (`AUDIT_ACTIONS` += 3)

**Interfaces:**
- Produces:
  - `TEMPLATE_VARIABLES = ['ticket.numero','ticket.asunto','cliente.email','agente.email'] as const`, `type TemplateVariable`.
  - `findInvalidPlaceholder(body: string): string | null` — devuelve el primer fragmento problemático (`'{{clinete.email}}'`, `'{{'`, `'}}'`) o `null`.
  - `CANNED_TITLE_MAX = 80`, `CANNED_BODY_MAX = 5000`.
  - `class CannedResponse extends Entity<CannedResponseId>` con getters `tenantId, title, titleKey, body, createdBy, createdAt, updatedAt`; `static create({id, tenantId, title, body, createdBy, now}): Result<CannedResponse, InvalidCannedResponseError>`; `rewrite({title, body, now}): Result<void, InvalidCannedResponseError>`; `static rehydrate(props)`.
  - `canonicalTitleKey(title: string): string` (trim + `toLowerCase()`).
  - Errores: `InvalidCannedResponseError` (`ticketing.invalid_canned_response`, mensaje dice el motivo), `CannedResponseNotFoundError` (`ticketing.canned_response_not_found`), `DuplicateCannedResponseTitleError` (`ticketing.duplicate_canned_response_title`).

- [ ] **Step 1: Tests que fallan** (`canned-response.entity.spec.ts`):
  - `findInvalidPlaceholder`: `null` para `'Hola {{ticket.numero}}'`, `'{{ ticket.asunto }}'`, texto sin llaves y las 4 variables juntas; `'{{clinete.email}}'` para ese typo; `'{{'` para `'Hola {{ticket.numero'`; `'{{'` para `'{{}}'`; no-null para `'{{{ticket.numero}}}'` y para `'{{Ticket.Numero}}'`; `'}}'` para `'fin }}'`.
  - `create`: recorta título y cuerpo; `titleKey` de `'  Saludo Inicial '` es `'saludo inicial'`; título vacío, de 81 caracteres, cuerpo vacío, cuerpo de 5001 y cuerpo con `{{x}}` → `err(InvalidCannedResponseError)` con el fragmento en el mensaje en el último caso.
  - `rewrite`: cambia título, `titleKey`, cuerpo y `updatedAt`; con cuerpo inválido no muta nada.
- [ ] **Step 2:** `corepack pnpm test -- canned-response` → FAIL (módulo no existe).
- [ ] **Step 3:** Implementar con dos regex exportadas (el front las copia en Task 7):
  - `VALID_PLACEHOLDER = /(?<!\{)\{\{\s*(ticket\.numero|ticket\.asunto|cliente\.email|agente\.email)\s*\}\}(?!\})/g` — el lookbehind/lookahead hace que `{{{ticket.numero}}}` NO cuente como válida.
  - Quitar todas las válidas y devolver la primera coincidencia de `/\{\{[^{}]*\}\}|\{\{|\}\}/` en el resto (un `{{x}}` desconocido sale entero; una llave suelta sale como `{{` o `}}`), o `null`.
  Llaves simples (`{a}`) siguen permitidas.
- [ ] **Step 4:** test → PASS. `corepack pnpm typecheck` limpio.
- [ ] **Step 5: Commit** `feat(ticketing): agregado CannedResponse con validación de variables`.

### Task 2: Puerto, doble y caso de uso de creación

**Files:**
- Create: `src/modules/ticketing/domain/ports/canned-response.repository.ts`
- Create: `src/modules/ticketing/application/canned-responses/create-canned-response.use-case.ts`
- Create: `src/modules/ticketing/application/canned-responses/canned-responses.spec.ts`
- Modify: `src/modules/ticketing/application/ticketing.test-doubles.ts` (`fakeCannedResponses`)

**Interfaces:**
- Consumes: Task 1.
- Produces:
  - `interface CannedResponseRepository { list(tenantId): Promise<CannedResponse[]> /* ordenado por title_key */; findById(tenantId, id): Promise<CannedResponse|null>; existsTitleKey(tenantId, titleKey, exceptId?: CannedResponseId): Promise<boolean>; insert(r): Promise<void>; update(r): Promise<void>; remove(tenantId, id): Promise<boolean> }` y `CANNED_RESPONSE_REPOSITORY = Symbol('ticketing.CannedResponseRepository')`.
  - `fakeCannedResponses(): FakeCannedResponses` con `stored(id)` (copias, como `fakeSlaTimers`).
  - `class CreateCannedResponse(transactions, repo, audit, ids: IdGenerator, clock)` · `execute({tenantId, actorId, title, body}): Promise<Result<CannedResponse, TicketingError>>`.

- [ ] **Step 1: Tests que fallan:** crea y guarda; audita `canned_response.created` con `metadata: { title }`; título duplicado sin distinguir mayúsculas (`'saludo'` vs existente `'Saludo'`) → `DuplicateCannedResponseTitleError` y sin auditoría; cuerpo inválido → `InvalidCannedResponseError` sin tocar el repo.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** Implementar con `runTransactional` (el error hace ROLLBACK). La unicidad se comprueba con `existsTitleKey` DENTRO de la transacción; la constraint única de la BD es la red (Task 4 mapea P2002).
- [ ] **Step 4:** PASS + typecheck.
- [ ] **Step 5: Commit** `feat(ticketing): crear respuestas predefinidas`.

### Task 3: Editar, borrar y listar

**Files:**
- Create: `.../canned-responses/update-canned-response.use-case.ts`, `delete-canned-response.use-case.ts`, `list-canned-responses.use-case.ts`
- Modify: `.../canned-responses/canned-responses.spec.ts`

**Interfaces:**
- Produces: `UpdateCannedResponse.execute({tenantId, actorId, id, title, body}): Result<CannedResponse, TicketingError>`; `DeleteCannedResponse.execute({tenantId, actorId, id}): Result<void, TicketingError>`; `ListCannedResponses.execute({tenantId}): Promise<CannedResponse[]>`.

- [ ] **Step 1: Tests que fallan:**
  - update: reescribe y audita `canned_response.updated` con `metadata: { before: {title, body}, after: {title, body} }`; id inexistente → `CannedResponseNotFoundError`; título de OTRA plantilla → duplicado; **`'Saludo'` → `'saludo'` en la misma plantilla NO es duplicado** (Review Focus 5, `existsTitleKey` con `exceptId`).
  - delete: borra y audita `canned_response.deleted` con `metadata: { title, body }`; inexistente → not found, sin auditoría.
  - list: devuelve ordenado por `titleKey`.
- [ ] **Step 2:** FAIL. **Step 3:** implementar. **Step 4:** PASS + typecheck.
- [ ] **Step 5: Commit** `feat(ticketing): editar, borrar y listar respuestas predefinidas`.

### Task 4: Persistencia — migración y repo Prisma

**Files:**
- Modify: `prisma/schema.prisma` (modelo `CannedResponse` + relación en `Organization`)
- Create: `prisma/migrations/20261112130000_canned_responses/migration.sql`
- Create: `src/modules/ticketing/infrastructure/persistence/prisma-canned-response.repository.ts`

**Interfaces:**
- Consumes: puerto de Task 2.
- Produces: tabla `canned_responses (id uuid pk, tenant_id uuid fk cascade, title text, title_key text, body text, created_by uuid, created_at, updated_at)`, `@@unique([tenantId, titleKey])`; `PrismaCannedResponseRepository` que extiende `PrismaRepository` y usa `runInTenant`. El repo NO captura `P2002`: en Postgres un statement fallido aborta la transacción entera (gotcha de la fase 5b), así que no hay nada que recuperar ahí. El caso normal lo cubre `existsTitleKey`; la carrera entre dos ADMIN la traduce el controller (Task 5) de `P2002` a 409.

- [ ] **Step 1:** Escribir el modelo y generar el SQL con `corepack pnpm prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --script` (requiere `--shadow-database-url` → usar una BD desechable `helpdesk_shadow`), copiarlo a `migration.sql` y añadir a mano el bloque RLS + GRANT idéntico al de `20261109120000_ai_triage`.
- [ ] **Step 2:** Validar en BD desechable: crear `helpdesk_migcheck`, `migrate deploy`, `migrate diff --from-url … --to-schema-datamodel … --exit-code` → `No difference detected.`, comprobar `relrowsecurity` y `relforcerowsecurity` = `t`, borrar la BD. Luego `corepack pnpm prisma:deploy` en la de desarrollo y `corepack pnpm prisma:generate`.
- [ ] **Step 3:** Implementar el repo (mapper en el propio archivo o en `ticketing.mappers.ts`).
- [ ] **Step 4:** typecheck limpio (la prueba real es el e2e de Task 5).
- [ ] **Step 5: Commit** `feat(ticketing): tabla canned_responses con RLS`.

### Task 5: HTTP + wiring + e2e

**Files:**
- Create: `src/modules/ticketing/infrastructure/http/canned-response.controller.ts`
- Create: `src/modules/ticketing/infrastructure/http/dto/canned-response.dto.ts`
- Modify: `src/modules/ticketing/infrastructure/http/ticketing-http.mapper.ts` (3 códigos)
- Modify: `src/modules/ticketing/ticketing.module.ts`
- Create: `test/canned-responses.e2e-spec.ts`

**Interfaces:**
- Consumes: Tasks 2–4.
- Produces: rutas del spec; DTO de respuesta `{ id, title, body, createdAt, updatedAt }` (ISO); listado `{ items }`. DTO de escritura con `class-validator` solo de forma (`@IsString`, `@MaxLength(80)` / `@MaxLength(5000)`); la regla de variables la decide el dominio.

- [ ] **Step 1: e2e que falla** (`canned-responses.e2e-spec.ts`, mismo andamiaje que `sla-policy.e2e-spec.ts`, dos organizaciones):
  - ADMIN crea → 201 con el cuerpo; AGENT lista y la ve; VIEWER `GET` → 403; AGENT `POST` → 403.
  - cuerpo `'Hola {{ticket.numero'` → 400 con `code: 'ticketing.invalid_canned_response'` (Review Focus 1).
  - título repetido con otras mayúsculas → 409.
  - `PUT` cambia; `DELETE` → 204 y desaparece del listado; `GET /tickets/:id/history` no aplica — en su lugar comprobar 3 filas en `audit_logs` con `entity_type = 'CannedResponse'`.
  - la otra organización: `GET` no la ve; `PUT`/`DELETE` sobre su id → 404 (RLS).
- [ ] **Step 2:** Bajar cualquier `start:dev`. `corepack pnpm test:e2e -- canned-responses` → FAIL (404 en las rutas).
- [ ] **Step 3:** Controller (`@MinRole` por método, `toHttpException`, `ParseUUIDPipe` en `:id`), mapper de códigos (invalid → 400, not found → 404, duplicate → 409), traducción de P2002 → 409, providers con `useFactory` como `UpdateSlaPolicy`.
- [ ] **Step 4:** e2e → PASS. `corepack pnpm test`, `typecheck`, `lint:ci` limpios.
- [ ] **Step 5: Commit** `feat(ticketing): endpoints de respuestas predefinidas`.

### Task 6: Docs y seed (backend)

**Files:**
- Modify: `docs/ARCHITECTURE.md` (ADR-0030 + índice), `README.md` (tabla de endpoints), `CLAUDE.md` (decisión locked + estado), `src/seed.ts` (3 plantillas al crear la org).

- [ ] **Step 1:** Seed con 3 plantillas: "Saludo inicial" (`Hola! Gracias por escribirnos. Ya estamos revisando el ticket {{ticket.numero}}.`), "Pedir más datos", "Cierre". Por el caso de uso `CreateCannedResponse`, como el resto del seed.
- [ ] **Step 2:** ADR-0030 con las 8 decisiones y los calls del spec (por qué texto y no macros; por qué el relleno en el front; `title_key` vs índice de expresión; regla de llaves duplicada por ADR-0001).
- [ ] **Step 3:** `corepack pnpm typecheck` + `lint:ci`.
- [ ] **Step 4: Commit** `docs: ADR-0030 respuestas predefinidas`.

### Task 7 (web): API, tipos y relleno de variables

**Files (repo `helpdesk-web`):**
- Modify: `src/lib/api/types.ts` (`CannedResponse`, `CannedResponseList`, `CannedResponseInput`)
- Create: `src/features/canned-responses/api.ts` (`listCannedResponses`, `createCannedResponse`, `updateCannedResponse`, `deleteCannedResponse`)
- Create: `src/features/canned-responses/queries.ts` (`useCannedResponses(habilitado)`, mutaciones que invalidan `cannedResponseKeys.all`)
- Modify: `src/lib/query/keys.ts` (`cannedResponseKeys = { all: ['canned-responses'] as const }`)
- Create: `src/features/canned-responses/fill.ts` + `fill.test.ts`

**Interfaces:**
- Produces: `fillTemplate(body: string, ctx: { ticketNumber: number; subject: string; customerEmail: string | null; agentEmail: string | null }): string` y `hasUnfilledPlaceholder(text: string): boolean` (misma regla que `findInvalidPlaceholder` del backend **más** las variables válidas que quedaron sin rellenar).

- [ ] **Step 1: Tests que fallan** (`fill.test.ts`): rellena las 4 (`#42`, asunto, emails); tolera espacio interno; `customerEmail` `null` o `''` → la variable queda literal; asunto `'Ayuda {{cliente.email}}'` se inserta literal y NO se re-rellena (Review Focus 2); `hasUnfilledPlaceholder` true para `'{{cliente.email}}'`, `'{{'`, `'{{x}}'`, false para texto normal.
- [ ] **Step 2:** `corepack pnpm test -- fill` → FAIL. **Step 3:** implementar (`replace` con UNA regex global y callback). **Step 4:** PASS + `corepack pnpm exec tsc --noEmit`.
- [ ] **Step 5: Commit** `feat(respuestas): cliente de API y relleno de variables`.

### Task 8 (web): selector en el editor del ticket

**Files:**
- Create: `src/features/canned-responses/components/canned-response-picker.tsx` + `.test.tsx`
- Modify: `src/features/tickets/components/ticket-comments.tsx` + `ticket-comments.test.tsx`

**Interfaces:**
- Consumes: Task 7.
- Produces: `<CannedResponsePicker open onOpenChange onPick={(r: CannedResponse) => void} />` con buscador por título (filtro en cliente, sin distinguir mayúsculas); `insertAtCursor(text, insertion, selectionStart, selectionEnd): { text: string; cursor: number }` exportada para test.

- [ ] **Step 1: Tests que fallan:**
  - `insertAtCursor('Hola  chau', 'X', 5, 5)` → `{ text: 'Hola X chau', cursor: 6 }`; con selección reemplaza solo lo seleccionado (Review Focus 3).
  - Solo el equipo ve el botón "Respuestas" (VIEWER no, y no dispara la query).
  - Elegir una plantilla inserta el texto rellenado en el editor.
  - `/` con el editor vacío abre el selector; con texto, escribe `/`.
  - En "Responder al cliente", con un `{{...}}` sin rellenar: aparece "Quedó una variable sin rellenar" y el primer envío NO llama a la mutación; el segundo sí. Editar el texto tras confirmar vuelve a pedirlo. En "Nota interna" no se pide.
- [ ] **Step 2:** FAIL. **Step 3:** implementar (ref al `Textarea`; `customerEmail` del `directorio(ticket.requesterId)?.email`; `agentEmail` de `useSession().user.email`). **Step 4:** PASS + tsc + `corepack pnpm lint`.
- [ ] **Step 5: Commit** `feat(respuestas): insertar respuestas predefinidas en el ticket`.

### Task 9 (web): página de configuración, sesión y docs

**Files:**
- Create: `src/app/(app)/settings/respuestas/layout.tsx` (metadata `Respuestas`), `page.tsx` + `page.test.tsx`
- Modify: `src/app/(app)/layout.tsx` (nav `{ href: '/settings/respuestas', etiqueta: 'Respuestas', icono: MessageSquareText, soloAdmin: true }`)
- Modify: `src/features/auth/session.tsx` (+ test en `session.test.tsx`): `email: perfil.email`
- Modify: `CLAUDE.md` y `README.md` del web.

- [ ] **Step 1: Tests que fallan:** la página lista, crea, edita y borra (borrar con confirmación en la propia fila, nunca `confirm()`); un 400 del backend muestra su `title` junto al campo; un 409 dice "Ya hay una respuesta con ese título". `session.test.tsx`: tras restaurar por refresh, `user.email` es el de `/auth/me` (Review Focus 4).
- [ ] **Step 2:** FAIL. **Step 3:** implementar siguiendo `settings/sla/page.tsx`. **Step 4:** `corepack pnpm test`, `tsc --noEmit`, `lint`, y `corepack pnpm build` → todo verde.
- [ ] **Step 5: Commit** `feat(respuestas): configuración de respuestas predefinidas`.

## Verificación final (después de Task 9)

- api: `corepack pnpm test`, `typecheck`, `lint:ci`, `test:e2e` completo (sin `start:dev` arriba).
- Revisión de toda la rama con un revisor fresco (modelo más capaz), con esta sección Review Focus.
- Prueba manual en Chrome: ADMIN crea una plantilla, agente la inserta en un ticket, variable sin rellenar pide confirmación.
- Preguntar al usuario antes de mergear a `dev`.
