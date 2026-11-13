# Vistas guardadas — diseño

**Fecha:** 2026-11-13 · **Estado:** decisiones 9–13 aprobadas por el usuario
(2026-11-12) · **Repos:** `helpdesk-api` + `helpdesk-web` · **ADR:** 0033 ·
**Entrega 3 de 3** (cierra etiquetas + búsqueda + vistas).

## Por qué

Un agente arma siempre las mismas combinaciones de filtros ("mis tickets en
curso con la etiqueta vip", "urgentes sin asignar que la IA marcó"). Volver a
armarlas cada vez es fricción; y el equipo necesita colas comunes.

## Decisiones aprobadas

9. **Qué guardan:** el conjunto de filtros (estado, "asignados a mí",
   etiquetas, texto de búsqueda, "la IA sugiere más urgencia") como JSON
   **validado y versionado**: una vista vieja no se rompe cuando aparezcan
   filtros nuevos.
10. **De quién son:** **personales** (cada agente las suyas) + **compartidas**
    con todo el equipo, que solo crea/edita/borra un ADMIN.
11. **"Asignados a mí" se guarda como "yo"**, no como un id: una vista
    compartida le muestra a cada uno lo suyo.
12. **Etiquetas:** "al menos una de" (como el filtro de la bandeja).
13. **UI:** en la barra lateral, debajo de "Tickets". **Sin contador.**

## Diseño (calls del asistente)

- **Solo el equipo (AGENT+).** Las vistas organizan el trabajo de la bandeja;
  un VIEWER recibe 403 (mismo criterio que etiquetas).
- **Tabla `saved_views`**: `id`, `tenant_id`, `owner_id` (NULL = compartida),
  `name`, `name_key`, `filters` (jsonb), `created_by`, fechas. RLS como todo.
  Unicidad del nombre **por ámbito** (las compartidas entre sí, las de cada
  persona entre sí): columna `scope_key` = `'shared'` o el id del dueño, con
  `@@unique([tenantId, scopeKey, nameKey])` (Postgres no hace únicos los NULL).
- **Visibilidad:** cada uno ve las compartidas + las suyas. La vista personal
  de otro es invisible: 404, igual que una que no existe.
- **Permisos de escritura:** una personal solo la toca su dueño; una
  compartida, solo un ADMIN. Crear compartida (`shared: true`) sin ser ADMIN →
  403. No se convierte una vista de personal a compartida (se crea otra).
- **Filtros v1** (dominio, función pura `parseViewFilters`):
  `{ version: 1, status?, assignee?: 'me', tagIds?: uuid[] (≤10), q?: string
  (≤200, recortado), aiSuggestsHigher?: true }`. Claves desconocidas o
  valores fuera de rango → 400 que dice cuál. Un `version` distinto de 1 →
  400 (la puerta para migrar versiones futuras está en esa función).
  Etiquetas borradas después no rompen la vista: el filtro de la bandeja ya
  tolera ids inexistentes (ADR-0031).
- **Sin auditoría ni evento:** es configuración de la interfaz, no un dato
  del negocio. El front invalida su query al guardar.
- **Endpoints:** `GET /views` (`{ items }`, compartidas primero y después por
  nombre), `POST /views` `{ name, filters, shared? }`, `PUT /views/:id`
  `{ name, filters }`, `DELETE /views/:id` → 204. Nombre 1–60, recortado.

## Web

- Barra lateral: debajo de "Tickets", las vistas (icono distinto para las
  compartidas). Clic → `/tickets?vista=<id>`.
- Bandeja: al abrir con `?vista=` aplica sus filtros al estado de la bandeja
  ("yo" → "Mis tickets"). Botón "Guardar vista" cuando hay algún filtro: pide
  nombre y, si es ADMIN, "Compartir con el equipo". Con una vista abierta y
  los filtros cambiados: "Actualizar vista"; y "Borrar vista" (confirmación en
  línea). Solo para el equipo.
- `useSearchParams` va dentro de un `Suspense` (Next lo exige para el build).

## Fuera de alcance

Contadores, orden manual, vistas por defecto al entrar, compartir con
personas puntuales, columnas configurables.

## Restricciones

RLS; `migrate diff` vacío en BD desechable; unit, e2e completos, lint,
typecheck; web tests, tsc, lint, build.
