# Vistas guardadas — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Guardar combinaciones de filtros de la bandeja como vistas personales o compartidas (ADMIN), visibles en la barra lateral.

**Spec:** `docs/superpowers/specs/2026-11-13-vistas-guardadas-design.md`

## Global Constraints

- Solo AGENT+ (VIEWER → 403). Personal: solo su dueño. Compartida: solo ADMIN escribe.
- Filtros v1: `{ version: 1, status?, assignee?: 'me', tagIds? (uuid, ≤10), q? (≤200, recortado), aiSuggestsHigher?: true }`; clave desconocida, versión ≠ 1 o valor inválido → 400 nombrando el campo.
- Nombre 1–60 recortado, único por ámbito sin distinguir mayúsculas (`scope_key` = `'shared'` | ownerId).
- Vista personal ajena → 404. Sin auditoría ni eventos.
- `migrate diff` vacío; generar el SQL antes de crear la carpeta (P3015). Commits con `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. Un AGENT intenta PUT/DELETE sobre una vista compartida o sobre la personal de otro → 403/404, nada cambia. (e2e T4)
2. `filters` con clave desconocida, `assignee: 'otro-id'`, 11 etiquetas, `version: 2` → 400. (unit T1 + e2e T4)
3. Dos personas con una vista personal del mismo nombre → permitido; dos compartidas con el mismo nombre → 409. (unit T2 + e2e T4)
4. Abrir `?vista=` de una vista que ya no existe → la bandeja muestra todo sin romper. (web T6)
5. Vista con `assignee: 'me'` abierta por dos agentes → cada uno ve lo suyo. (web T6: se traduce a "Mis tickets")

---

### Task 1: Dominio
`domain/saved-view/` — `parseViewFilters(raw: unknown): Result<ViewFilters, InvalidSavedViewError>`, `SavedView` (create/rewrite/rehydrate; `isShared`, `scopeKey`, `nameKey`), errores `InvalidSavedViewError` (400), `SavedViewNotFoundError` (404), `DuplicateSavedViewNameError` (409), `SavedViewForbiddenError` (403); `SavedViewId`. Tests de todos los casos de Review Focus 2.

### Task 2: Casos de uso
Puerto `SavedViewRepository { listVisible(tenantId, userId); findVisible(tenantId, userId, id); existsName(tenantId, scopeKey, nameKey, exceptId?); insert; update; remove }` + doble. `ListSavedViews`, `CreateSavedView` (`shared` exige ADMIN), `UpdateSavedView` / `DeleteSavedView` (personal: dueño; compartida: ADMIN; ajena → not found). Tests: permisos, duplicados por ámbito (Review Focus 3).

### Task 3: Persistencia
Modelo `SavedView` + migración `20261113140000_saved_views` (RLS). Validar en BD desechable. Repo Prisma: `listVisible` = `owner_id = userId OR owner_id IS NULL`, compartidas primero y por `name_key`.

### Task 4: HTTP + e2e
`SavedViewController` (`/views`, `@MinRole('AGENT')`, el rol del token va al caso de uso), mapper (4 códigos), wiring; `test/saved-views.e2e-spec.ts` con Review Focus 1–3, aislamiento entre organizaciones y VIEWER → 403.

### Task 5: Docs
ADR-0033 + índice, README (endpoints), CLAUDE.md (cierra la entrega 3 y el pendiente).

### Task 6 (web)
Tipos + `features/views/{api,queries}.ts`; `filtrosDeVista`/`vistaDesdeFiltros` puros con tests (ida y vuelta, `'me'` ↔ "Mis tickets", vacío se omite); barra lateral con las vistas; bandeja con `?vista=` (dentro de `Suspense`), "Guardar vista" (diálogo, "Compartir" solo ADMIN), "Actualizar vista", "Borrar vista"; vista inexistente → sin filtros (Review Focus 4). `pnpm test`, tsc, lint, build.

## Verificación final
e2e completos, revisor fresco (opus) sobre los dos repos, preguntar antes de mergear.
