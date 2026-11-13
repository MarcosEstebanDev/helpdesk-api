# Horario laboral — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** que el SLA cuente solo el tiempo hábil de cada organización (semana tipo + excepciones por fecha, o 24/7 por interruptor) y que el cliente sepa cuándo lo van a atender si escribe fuera de horario.

**Architecture:** un `BusinessCalendar` puro en el dominio implementa `SlaCalendar` a partir de una `BusinessCalendarConfig`; un puerto `BusinessCalendarRepository` la lee por tenant (sin fila = valores por defecto) y los tres usos de `CALENDAR_24_7` pasan a pedirla. Configuración ADMIN por HTTP con auditoría; un endpoint de estado mínimo para cualquier rol alimenta el aviso del web.

**Tech Stack:** NestJS 11 hexagonal, Prisma 6 + Postgres 17 (RLS), `Intl.DateTimeFormat` para zonas IANA (sin dependencia nueva), Next.js 16 + TanStack Query 5 + Vitest.

**Spec:** `docs/superpowers/specs/2026-11-13-horario-laboral-design.md`

## Global Constraints

- Valores por defecto: modo `business_hours`, lunes a viernes, `08:00`–`18:00`, `America/Argentina/Buenos_Aires`.
- Modos: `business_hours` | `24_7`. En `24_7` el calendario es `CALENDAR_24_7` (semana y excepciones se conservan sin aplicarse).
- Fábrica de SLA: NORMAL resolución `10 * 60`, LOW resolución `30 * 60`; URGENT y HIGH sin cambios.
- Configurar: solo ADMIN. Estado (`open`, `nextOpening`, `timeZone`): cualquier rol; nada más de la configuración viaja al VIEWER.
- Cambiar el horario NO recalcula relojes vivos; reanudar/parar usa el calendario ACTUAL del tenant.
- Tablas nuevas con RLS ENABLE+FORCE y policy `tenant_isolation` fail-closed como las demás; `tenantId` solo del JWT.
- Todo cálculo en la zona horaria guardada, nunca en la del proceso.
- Feriados precargables: año actual y siguiente, solo nacionales oficiales (inamovibles + trasladables ya trasladados); sin "no laborables turísticos" ni 24/31 dic; no pisan excepciones existentes.
- Aviso fuera de horario: solo VIEWER, en el formulario de abrir ticket (antes de enviar) y sobre la caja de respuesta.
- Repo api con `core.autocrlf=true`: editar con Edit, no con replaces de Python. `corepack pnpm`. No correr e2e con `start:dev` arriba. Commits con `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. Ticket creado con la oficina cerrada (sábado 22:00) → el reloj arranca el lunes 08:00, no corre el fin de semana. (T1)
2. Vencimiento que cae justo al cierre (17:00 + 60 min) → mismo día 18:00, no el día siguiente 08:00. (T1)
3. Feriado en martes y sábado marcado hábil pisan la semana tipo. (T1)
4. Modo `24_7` se comporta exactamente como hoy: los e2e de SLA existentes pasan fijando 24/7. (T4)
5. Calendario sin días hábiles alcanzables → error explícito, no un bucle infinito. (T1)

---

### Task 1: Dominio — `BusinessCalendar` y fábrica de SLA ajustada

**Files:**
- Create: `src/modules/ticketing/domain/sla/business-calendar.ts`, `business-calendar.spec.ts` (misma carpeta)
- Modify: `src/modules/ticketing/domain/sla/sla-calendar.ts` (CALENDAR_24_7 implementa también `isOpenAt`/`nextOpeningAfter`), `sla-policy.ts:31-36` (+ su spec)

**Interfaces:**
- Produces:
  ```ts
  export type Weekday = 1 | 2 | 3 | 4 | 5 | 6 | 7; // ISO: 1 = lunes
  export interface CalendarException { date: string /* YYYY-MM-DD */; working: boolean; name: string }
  export type BusinessCalendarConfig =
    | { mode: '24_7' }
    | { mode: 'business_hours'; timeZone: string; weekdays: readonly Weekday[];
        opensAtMinute: number; closesAtMinute: number; // minutos desde 00:00
        exceptions: readonly CalendarException[] };
  export const DEFAULT_BUSINESS_HOURS: Extract<BusinessCalendarConfig, { mode: 'business_hours' }>; // L–V, 480, 1080, AR, []
  export interface BusinessCalendar extends SlaCalendar { isOpenAt(at: Date): boolean; nextOpeningAfter(at: Date): Date | null }
  export function toBusinessCalendar(config: BusinessCalendarConfig): BusinessCalendar;
  export function makeBusinessHours(input: { timeZone: string; weekdays: number[]; opensAt: string; closesAt: string })
    : Result<{ timeZone; weekdays: Weekday[]; opensAtMinute; closesAtMinute }, TicketingError>; // code 'INVALID_BUSINESS_HOURS'
  export const MAX_SEARCH_DAYS = 730;
  ```
  `nextOpeningAfter` devuelve `null` si está abierto en `at`. `CALENDAR_24_7.isOpenAt` → siempre `true`, `nextOpeningAfter` → `null`.

- [ ] **Step 1: Tests que fallan** (`business-calendar.spec.ts`, instantes en UTC; ART = UTC-3; 2026-11-13 es viernes)
  - `dueAt(2026-11-13T20:00Z /*vie 17:00*/, 240)` → `2026-11-16T14:00Z` (lun 11:00). **Focus 1/2 abajo.**
  - `dueAt(2026-11-14T01:00Z /*vie 22:00*/, 60)` → `2026-11-16T12:00Z` (lun 09:00); `dueAt(sáb 2026-11-14T13:00Z, 60)` igual. (Focus 1)
  - `dueAt(2026-11-13T20:00Z, 60)` → `2026-11-13T21:00Z` (vie 18:00, no lun 08:00). (Focus 2)
  - Excepción `{date:'2026-11-16', working:false}`: `dueAt(vie 17:00, 240)` → `2026-11-17T14:00Z`; excepción `{date:'2026-11-14', working:true}`: → `2026-11-14T14:00Z` (sáb 11:00). (Focus 3)
  - `workingMinutesBetween(vie 17:00, lun 11:00)` → `240`; con `to <= from` → `0`; y `dueAt(x, workingMinutesBetween(x, y)) === y` para y dentro de horario.
  - Misma config con `timeZone: 'Europe/Madrid'`: `dueAt(2026-11-13T16:00Z /*vie 17:00 CET*/, 60)` → `2026-11-13T17:00Z` (la zona del proceso no importa).
  - `isOpenAt(vie 17:00)` → true; `isOpenAt(sáb)` → false; `nextOpeningAfter(sáb 2026-11-14T13:00Z)` → `2026-11-16T11:00Z`; `nextOpeningAfter(vie 17:00)` → `null`.
  - `weekdays: [1]` con excepciones no hábiles para todos los lunes de 2 años → `dueAt` lanza `Error` con mensaje que contenga `'sin días hábiles'`. (Focus 5)
  - `toBusinessCalendar({mode:'24_7'})` devuelve `CALENDAR_24_7`.
  - `makeBusinessHours`: rechaza `weekdays: []`, `opensAt: '18:00', closesAt: '08:00'`, `'25:00'`, `timeZone: 'Marte/Olimpo'`; acepta los valores por defecto.
  - `sla-policy.spec.ts`: `DEFAULT_SLA_POLICY.NORMAL.resolutionMinutes === 600`, `LOW.resolutionMinutes === 1800`.
- [ ] **Step 2:** `corepack pnpm jest src/modules/ticketing/domain/sla` → FAIL (módulo inexistente / valores viejos).
- [ ] **Step 3: Implementar.** Recorrer días calendario en la zona del config: para cada fecha local decidir hábil (excepción si existe, si no `weekdays`), intersectar `[max(cursor, apertura), cierre)` y consumir minutos; fallar tras `MAX_SEARCH_DAYS`. Convertir "fecha local + minuto" a instante con `Intl.DateTimeFormat(…, { timeZone, hourCycle: 'h23', … })` calculando el offset de ese instante (no suponer offset fijo). Validar zona con `new Intl.DateTimeFormat('en', { timeZone })` en try/catch.
- [ ] **Step 4:** `corepack pnpm jest src/modules/ticketing/domain/sla` → PASS; `corepack pnpm typecheck` limpio.
- [ ] **Step 5: Commit** `feat(sla): calendario de días hábiles en el dominio y fábrica en horas hábiles`.

### Task 2: Persistencia — tablas, migración y repositorio

**Files:**
- Modify: `prisma/schema.prisma` (modelos `BusinessCalendar`, `BusinessCalendarException`, enum `BusinessCalendarMode { BUSINESS_HOURS TWENTY_FOUR_SEVEN }`)
- Create: `prisma/migrations/20261113160000_business_hours/migration.sql`, `src/modules/ticketing/domain/ports/business-calendar.repository.ts`, `src/modules/ticketing/infrastructure/persistence/prisma-business-calendar.repository.ts`
- Modify: `src/modules/ticketing/ticketing.module.ts` (provider + token)
- Test: `test/business-hours-persistence.e2e-spec.ts`

**Interfaces:**
- Consumes: `BusinessCalendarConfig`, `CalendarException`, `DEFAULT_BUSINESS_HOURS` (T1).
- Produces (`BUSINESS_CALENDAR_REPOSITORY`):
  ```ts
  export interface BusinessCalendarRepository {
    configOf(tenantId: TenantId): Promise<{ config: BusinessCalendarConfig; source: 'default' | 'organization';
      week: { timeZone; weekdays; opensAtMinute; closesAtMinute } /* también en 24_7 */ ;
      exceptions: (CalendarException & { id: string })[] }>;
    saveWeek(input: { tenantId; mode: '24_7' | 'business_hours'; week: {…}; now: Date }): Promise<void>; // upsert
    addException(input: { tenantId; id: string; exception: CalendarException; now: Date }): Promise<'added' | 'duplicate'>;
    addExceptions(input: { tenantId; items: { id: string; exception: CalendarException }[]; now: Date }): Promise<number>; // skipDuplicates, devuelve cuántas
    removeException(tenantId: TenantId, id: string): Promise<boolean>;
  }
  ```
  Sin fila en `business_calendars` → `source: 'default'` y `DEFAULT_BUSINESS_HOURS` (no hay backfill).
- Tablas: `business_calendars` (PK `tenant_id`, `mode`, `time_zone`, `weekdays smallint[]`, `opens_at_minute smallint`, `closes_at_minute smallint`, `updated_at`), `business_calendar_exceptions` (`id uuid`, `tenant_id`, `date date`, `working bool`, `name text`, `created_at`, `UNIQUE(tenant_id, date)`). GRANT DML a `helpdesk_app`, ENABLE+FORCE RLS, policy `tenant_isolation` idéntica a `sla_policies`.

- [ ] **Step 1: e2e que falla:** sin configurar → `source: 'default'` con L–V 480–1080; `saveWeek` + `configOf` devuelve lo guardado; `addException` dos veces la misma fecha → `'duplicate'`; `addExceptions` con una fecha ya cargada devuelve `n-1` y NO cambia la existente; otro tenant no ve nada (RLS).
- [ ] **Step 2:** `corepack pnpm test:e2e -- business-hours-persistence` → FAIL.
- [ ] **Step 3:** schema + SQL (generar con `prisma migrate diff`, crear la carpeta DESPUÉS — gotcha P3015) + repo dentro de `runInTenant` + wiring.
- [ ] **Step 4:** e2e PASS; validar la migración en BD desechable: `migrate deploy` + `migrate diff` vacío.
- [ ] **Step 5: Commit** `feat(sla): tablas y repositorio del horario laboral (RLS)`.

### Task 3: HTTP — configuración ADMIN, feriados y estado

**Files:**
- Create: `src/modules/ticketing/application/business-hours/{get-business-hours,update-business-hours,add-calendar-exception,remove-calendar-exception,load-national-holidays,get-business-status}.use-case.ts` (+ `business-hours-use-cases.spec.ts`), `src/modules/ticketing/domain/sla/argentina-holidays.ts` (+ spec), `src/modules/ticketing/infrastructure/http/business-hours.controller.ts`, DTOs en `infrastructure/http/dto/business-hours.dto.ts`
- Modify: `AUDIT_ACTIONS` del dominio (+ `business_hours.changed`), `ticketing.module.ts`
- Test: `test/business-hours.e2e-spec.ts`

**Interfaces:**
- Consumes: T1 (`makeBusinessHours`, `toBusinessCalendar`), T2 (repo).
- Produces (HTTP):
  - `GET /business-hours` (ADMIN) → `{ mode: 'business_hours'|'24_7', timeZone, weekdays: number[], opensAt: 'HH:MM', closesAt: 'HH:MM', source: 'default'|'organization', exceptions: { id, date, working, name }[] }` (ordenadas por fecha)
  - `PUT /business-hours` (ADMIN) body `{ mode, timeZone, weekdays, opensAt, closesAt }` → igual que GET; 400 `INVALID_BUSINESS_HOURS`
  - `POST /business-hours/exceptions` (ADMIN) `{ date, working, name }` → 201 con la excepción; 409 si la fecha ya existe
  - `DELETE /business-hours/exceptions/:id` (ADMIN) → 204 (404 si no existe)
  - `POST /business-hours/holidays/:year` (ADMIN, `year` ∈ {actual, actual+1}) → `{ added: number, skipped: number }`
  - `GET /business-hours/status` (VIEWER) → `{ open: boolean, nextOpening: string | null, timeZone: string }`
  - Rutas fijas antes que `:id`. Auditoría `business_hours.changed` en la misma transacción, `entity_id` = tenant, `metadata: { change: 'week'|'exception_added'|'exception_removed'|'holidays_loaded', … }`.
  - `nationalHolidays(year: number): CalendarException[] | null` en `argentina-holidays.ts`.

- [ ] **Step 1: Tests que fallan.**
  - `argentina-holidays.spec.ts`: `nationalHolidays(2026)` incluye los inamovibles `2026-01-01, 03-24, 04-02, 05-01, 05-25, 06-20, 07-09, 12-08, 12-25`, todos `working:false`, fechas únicas y del año pedido; NO incluye `12-24` ni `12-31`; `nationalHolidays(2030)` → `null`.
  - e2e: VIEWER y AGENT reciben 403 en GET/PUT/POST/DELETE y 200 en `/status`; `/status` de un VIEWER no trae otras claves que `open`, `nextOpening`, `timeZone`; PUT inválido → 400 con `code`; feriados dos veces → la segunda `added: 0`; año fuera de rango → 400; cada cambio deja una entrada `business_hours.changed`.
  - `/status` con `CLOCK` inyectado en sábado → `open:false`, `nextOpening` = lunes 08:00 en la zona.
- [ ] **Step 2:** unit + e2e → FAIL.
- [ ] **Step 3:** implementar. Las fechas de 2026 y 2027 se toman del calendario oficial (argentina.gob.ar / decreto de feriados del año), con los trasladables ya movidos; citar la fuente en un comentario del archivo. Si 2027 no está publicado, incluir inamovibles + los trasladables según la Ley 27.399 y dejarlo dicho en el comentario.
- [ ] **Step 4:** unit + e2e PASS, `typecheck`, `lint:ci`.
- [ ] **Step 5: Commit** `feat(sla): configuración del horario laboral por API`.

### Task 4: El SLA usa el calendario del tenant

**Files:**
- Modify: `application/sla/start-sla-timers.use-case.ts`, `stop-sla-timer.use-case.ts`, `sla-pause-coordinator.ts` (+ sus specs y `ticketing.module.ts` para inyectar el repo)
- Modify: los e2e de SLA existentes (`grep -l "sla" test/*.e2e-spec.ts`) para fijar 24/7 en su `beforeAll` con `PUT /business-hours` `mode:'24_7'`
- Create: `test/sla-business-hours.e2e-spec.ts`

**Interfaces:**
- Consumes: `BusinessCalendarRepository.configOf` (T2), `toBusinessCalendar` (T1).
- Produces: los tres constructores reciben además `calendars: BusinessCalendarRepository`; el calendario se pide dentro de la transacción ya abierta.

- [ ] **Step 1: Tests que fallan.**
  - unit (fakes): `StartSlaTimers` con config L–V y `occurredAt` viernes 17:00 ART, URGENT → reloj de RESPUESTA `dueAt` vie 17:15 y de RESOLUCIÓN lunes 11:00; en `24_7` → igual que hoy. `SlaPauseCoordinator` reanuda con el calendario del tenant (pausa vie 17:30 con `dueAt` vie 17:45, reanuda lun 08:00 → `dueAt` lun 08:15).
  - e2e `sla-business-hours`: con `CLOCK` en sábado 22:00 ART, crear ticket NORMAL y procesar SLA → respuesta vence lunes 12:00 ART (4 h desde 08:00). (Focus 1)
  - Los e2e de SLA existentes, con 24/7 fijado, pasan SIN cambiar sus aserciones. (Focus 4)
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** reemplazar los tres `CALENDAR_24_7` por `toBusinessCalendar((await calendars.configOf(tenantId)).config)`; actualizar el comentario "Mismo calendario con el que arrancó el reloj" del coordinador (ahora: el ACTUAL del tenant, decisión del spec).
- [ ] **Step 4:** `corepack pnpm test`, e2e de SLA (`-- sla`) PASS.
- [ ] **Step 5: Commit** `feat(sla): los relojes cuentan en el horario de cada organización`.

### Task 5 (web): pantalla `/settings/horario` y SLA en horas hábiles

**Files (helpdesk-web, rama `feat/horario-laboral` desde `dev`):**
- Create: `src/features/business-hours/{api.ts,queries.ts,api.test.ts}`, `src/app/(app)/settings/horario/page.tsx`, `src/features/business-hours/components/{week-form.tsx,exceptions-list.tsx}` (+ tests)
- Modify: `src/lib/api/types.ts` (tipos de T3), `src/lib/query/keys.ts` (`businessHoursKeys = { config: ['business-hours','config'], status: ['business-hours','status'] }`), nav del layout (entrada `soloAdmin` "Horario"), `src/app/(app)/settings/sla/page.tsx` (texto "horas hábiles" salvo en 24/7; pide `GET /business-hours` solo para saber el modo), `AUDIT_ACTIONS` + `describirEntrada` (`business_hours.changed` → "Cambió el horario laboral")

**Interfaces:**
- Consumes: HTTP de T3.
- Produces: `useBusinessHours(habilitado)`, `useBusinessStatus(habilitado)`, mutaciones que invalidan `businessHoursKeys.config` y `.status`.

- [ ] **Step 1: Tests que fallan:** `week-form` no deja guardar sin días ni con cierre ≤ apertura y manda `{mode,timeZone,weekdays,opensAt,closesAt}`; con el interruptor 24/7 los campos quedan deshabilitados pero conservan su valor; `exceptions-list` muestra fecha, nombre y "hábil/no hábil", borra en la propia fila (sin `confirm()`), y el botón "Agregar feriados nacionales {año}" existe para el año actual y el siguiente y avisa `"Se agregaron N feriados (M ya estaban)"`.
- [ ] **Step 2:** `corepack pnpm test` → FAIL.
- [ ] **Step 3:** implementar con los primitivos existentes (`components/ui/primitives.tsx`).
- [ ] **Step 4:** test, `typecheck`, `lint` PASS.
- [ ] **Step 5: Commit** `feat(horario): configuración del horario laboral y SLA en horas hábiles`.

### Task 6 (web): aviso al cliente y vencimientos con fecha

**Files:**
- Create: `src/features/business-hours/components/aviso-fuera-de-horario.tsx` (+ test), `src/features/business-hours/format.ts` (+ test)
- Modify: diálogo `NuevoTicket` en `src/app/(app)/tickets/page.tsx`, `src/features/tickets/components/ticket-comments.tsx` (sobre la caja, solo VIEWER), `src/features/tickets/inbox/presentacion.ts` y `src/features/tickets/components/sla-panel.tsx` (fecha si faltan > 24 h)

**Interfaces:**
- Consumes: `useBusinessStatus` (T5).
- Produces: `textoProximaApertura(nextOpening: string, timeZone: string, ahora: Date): string`; `vencimientoLegible(dueAt: string, timeZone: string | undefined, ahora: Date): string`.

- [ ] **Step 1: Tests que fallan.**
  - `textoProximaApertura('2026-11-16T11:00:00Z', 'America/Argentina/Buenos_Aires', sáb)` → `"Estamos fuera de horario. Lo vamos a ver a partir del lunes 16/11 a las 8:00."`; si es hoy → `"… a partir de hoy a las 8:00."`.
  - El aviso se muestra a un VIEWER con `open:false`, no se muestra con `open:true`, y a un AGENT ni se pide el estado.
  - `describirSla` con `dueAt` a 50 h → `{ texto: 'vence lun 16/11 11:00', tono: 'neutro' }`; a 3 h sigue `'vence en 3 h'`. La zona para formatear: la del navegador si no hay otra (la bandeja no la conoce; anotarlo).
- [ ] **Step 2–4:** FAIL → implementar → PASS (+ typecheck, lint).
- [ ] **Step 5: Commit** `feat(horario): aviso fuera de horario al cliente y vencimientos con fecha`.

### Task 7: Docs, seed y verificación final

**Files:**
- Modify: `docs/ARCHITECTURE.md` (ADR-0034 nuevo + índice; adenda ADR-0020 decisión 5 y valores de fábrica; adenda ADR-0029 "Revisar si" resuelto: calendario actual del tenant y su efecto en la transición), `README.md` (endpoints), `CLAUDE.md` de los dos repos, `docs/ROADMAP.md` (no objetivos del spec como pendientes), `src/seed.ts` (acme: calendario por defecto explícito + feriados del año actual vía el caso de uso)

- [ ] **Step 1:** escribir docs y seed; `corepack pnpm seed` idempotente (segunda corrida no agrega).
- [ ] **Step 2:** api: `lint:ci`, `typecheck`, `test`, `test:e2e` completos (Docker arriba, sin `start:dev`), `build`; migración en BD desechable sin drift. web: `test`, `typecheck`, `lint`, `build`.
- [ ] **Step 3:** revisión fresca de la rama (ambos repos) y aplicar lo que corresponda.
- [ ] **Step 4:** demo en Chrome: configurar horario, cargar feriados, abrir un ticket como VIEWER fuera de horario y ver el aviso; ver un vencimiento corrido al lunes.
- [ ] **Step 5: Commit** `docs: ADR-0034 horario laboral` y PREGUNTAR antes de mergear a `dev`.
