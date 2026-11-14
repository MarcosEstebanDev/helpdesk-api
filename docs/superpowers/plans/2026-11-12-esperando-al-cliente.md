# Esperando al cliente — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Estado `WAITING_ON_CUSTOMER` que pausa el reloj de resolución del SLA y vuelve solo a `IN_PROGRESS` cuando comenta alguien que no es del equipo.

**Architecture:** La regla de transiciones sigue en `domain/ticket-status.ts`. El reloj gana `paused_at` y un estado derivado `paused`. Pausar y reanudar ocurren en la MISMA transacción del cambio de estado (`SlaPauseCoordinator`, usado por `ChangeTicketStatus` y `AddComment`); parar e incumplir siguen en diferido, pero todas las transiciones del reloj se escriben con `UPDATE ... WHERE` condicionado.

**Tech Stack:** NestJS 11, Prisma 6, PostgreSQL 17 (RLS), BullMQ, Jest + supertest; Next.js + Vitest en `helpdesk-web`.

**Spec:** `docs/superpowers/specs/2026-11-12-esperando-al-cliente-design.md` (leerlo antes de empezar; este plan argumenta desde él).

## Global Constraints

- Idioma de código, comentarios, commits y docs: español, como el resto del repo.
- `pnpm` no está en el PATH: usar `corepack pnpm`. Git: `"$LOCALAPPDATA/Programs/PortableGit/cmd/git.exe"` (en este documento, `git`). Git sobre OneDrive es lento: timeouts largos.
- **Commitear al terminar cada task** (OneDrive ya revirtió el árbol una vez).
- Ramas: api ya está en `feat/esperando-al-cliente` (sale de `dev`). Web: crear `feat/esperando-al-cliente` desde `dev` en la Task 11. No mergear ni pushear sin OK de Marcos.
- Dominio y aplicación puros (sin Nest ni Prisma). Errores como `Result`.
- Todo cambio de estado del ticket pasa por `Ticket.changeStatus`.
- El estado del reloj se DERIVA de fechas; nunca un campo `status`.
- Prohibido `prisma migrate reset`. Validar migraciones en BD desechable + `prisma migrate diff` vacío.
- Docker Desktop arrancado a mano antes de los e2e. No correr e2e con un `start:dev` levantado. No canalizar la salida de los e2e por `| tail` / `| grep`.
- Al ampliar un puerto, ampliar su doble en `application/ticketing.test-doubles.ts`.
- Antes de dar algo por cerrado: `corepack pnpm lint:ci`, `corepack pnpm typecheck`, `corepack pnpm test`, `corepack pnpm test:e2e`, `corepack pnpm build`.

## Review Focus

1. **Resolver directo desde la espera**: el reloj tiene que terminar `met` (o `breached` si ya venció), nunca quedar `paused` para siempre. → test en Task 6 y e2e en Task 9.
2. **Espera → retomar → espera en segundos**: el tramo trabajado SÍ cuenta para el SLA. → test en Task 7 y e2e en Task 9.
3. **Nota interna o comentario del equipo en un ticket en espera**: no lo saca de la espera. → test en Task 2 y e2e en Task 9.
4. **Ticket con el reloj de resolución ya incumplido (o sin reloj) que pasa a espera**: el cambio de estado funciona, el reloj sigue `breached` y la UI no lo muestra "en pausa". → tests en Task 4 y Task 7.
5. **`CLOSED` u `OPEN` directo desde la espera**: 409 como cualquier transición ilegal. → test en Task 1 y e2e en Task 9.

---

### Task 1: Estado `WAITING_ON_CUSTOMER` en la máquina de estados

**Files:**
- Modify: `src/modules/ticketing/domain/ticket-status.ts` (lista, tabla y comentario de cabecera)
- Modify: `src/modules/ticketing/domain/entities/ticket.entity.ts` (`applyLifecycleTimestamps`, si su `switch` es exhaustivo)
- Test: `src/modules/ticketing/domain/ticket-status.spec.ts` (el existente)

**Interfaces:**
- Produces: `TicketStatus` incluye `'WAITING_ON_CUSTOMER'`; `canTransition`/`allowedTransitionsFrom` con la tabla de la decisión 1 del spec.

- [ ] **Step 1: Ampliar el test de la tabla**: los casos nuevos `IN_PROGRESS → WAITING_ON_CUSTOMER` legal, `WAITING_ON_CUSTOMER → IN_PROGRESS` y `→ RESOLVED` legales, `WAITING_ON_CUSTOMER → OPEN | CLOSED` ilegales, `OPEN → WAITING_ON_CUSTOMER` y `RESOLVED → WAITING_ON_CUSTOMER` ilegales; `allowedTransitionsFrom('WAITING_ON_CUSTOMER')` igual a `['IN_PROGRESS', 'RESOLVED']`; `isTerminal('WAITING_ON_CUSTOMER') === false`.
- [ ] **Step 2: Correr y ver que falla**: `corepack pnpm test -- ticket-status` → FAIL.
- [ ] **Step 3: Implementar** el valor en `TICKET_STATUSES` (después de `IN_PROGRESS`) y las filas de `ALLOWED_TRANSITIONS`. Actualizar el diagrama del comentario. En `applyLifecycleTimestamps`, entrar o salir de la espera no toca `resolvedAt`/`closedAt`.
- [ ] **Step 4: Correr** `corepack pnpm test -- ticket` → PASS, y `corepack pnpm typecheck` limpio (va a señalar los `Record<TicketStatus, …>` que hay que completar: DTOs, mappers; completarlos con el valor nuevo).
- [ ] **Step 5: Commit** `feat(ticketing): estado WAITING_ON_CUSTOMER en la máquina de estados`.

### Task 2: Vuelta automática a `IN_PROGRESS` en `registerComment`

**Files:**
- Modify: `src/modules/ticketing/domain/entities/ticket.entity.ts` (`registerComment`)
- Test: `src/modules/ticketing/domain/entities/ticket.entity.spec.ts`

**Interfaces:**
- Consumes: `isResponder(role: string): boolean` de `domain/sla/responder-role.ts`; Task 1.
- Produces: tras `registerComment`, `ticket.status` puede haber pasado de `WAITING_ON_CUSTOMER` a `IN_PROGRESS`; los eventos salen en orden `comment.added`, `ticket.status_changed` (`from: 'WAITING_ON_CUSTOMER'`, `to: 'IN_PROGRESS'`).

- [ ] **Step 1: Tests** (ticket en espera salvo que se diga otra cosa):
  - `VIEWER` + `PUBLIC` → `status === 'IN_PROGRESS'` y `pullDomainEvents()` termina en un `ticket.status_changed` con `from`/`to` correctos.
  - `VIEWER` + `INTERNAL` no ocurre (lo impide `Comment.write`), pero `AGENT` + `PUBLIC`, `AGENT` + `INTERNAL` y `ADMIN` + `PUBLIC` → sigue `WAITING_ON_CUSTOMER` y solo emite `comment.added`.
  - Ticket en `IN_PROGRESS` + `VIEWER` + `PUBLIC` → sigue `IN_PROGRESS`, sin `status_changed`.
- [ ] **Step 2: Correr y ver que falla.**
- [ ] **Step 3: Implementar**: después de emitir `comment.added`, si `status === 'WAITING_ON_CUSTOMER' && visibility === 'PUBLIC' && !isResponder(authorRole)` → `this.changeStatus('IN_PROGRESS', now)` (propagar su `Result`).
- [ ] **Step 4: Correr** `corepack pnpm test -- ticket.entity` → PASS.
- [ ] **Step 5: Commit** `feat(ticketing): el comentario del cliente saca al ticket de la espera`.

### Task 3: `SlaCalendar.workingMinutesBetween`

**Files:**
- Modify: `src/modules/ticketing/domain/sla/sla-calendar.ts`
- Test: `src/modules/ticketing/domain/sla/sla-calendar.spec.ts`

**Interfaces:**
- Produces: `SlaCalendar.workingMinutesBetween(from: Date, to: Date): number` — minutos de trabajo entre dos instantes, sin redondear, 0 si `to <= from`.

- [ ] **Step 1: Tests de `CALENDAR_24_7`**: entre `10:00` y `10:30` → `30`; entre `10:00:00` y `10:00:30` → `0.5`; `to` anterior a `from` → `0`; y la propiedad `dueAt(from, workingMinutesBetween(from, to))` igual a `to`.
- [ ] **Step 2: Correr y ver que falla.**
- [ ] **Step 3: Implementar** en la interfaz y en `CALENDAR_24_7` (diferencia en ms / 60 000, mínimo 0). Ampliar el comentario de la costura: es lo que usará la reanudación cuando llegue el horario laboral.
- [ ] **Step 4: Correr** → PASS. `corepack pnpm typecheck` (otros calendarios falsos en tests, si existen, también la necesitan).
- [ ] **Step 5: Commit** `feat(sla): el calendario sabe medir minutos de trabajo entre dos instantes`.

### Task 4: Pausa en `SlaTimer` y en `describeSlaTimer`

**Files:**
- Modify: `src/modules/ticketing/domain/sla/sla-timer.entity.ts`
- Test: `src/modules/ticketing/domain/sla/sla-timer.entity.spec.ts`

**Interfaces:**
- Consumes: Task 3.
- Produces:
  - `SlaTimerProps.pausedAt: Date | null`; getter `pausedAt`; `rehydrate` lo recibe; `start` lo crea en `null`.
  - `isRunning(): boolean` — sin parar, sin incumplir **y sin pausa**.
  - `isPaused(): boolean`; `isOpen(): boolean` (sin parar y sin incumplir: corriendo o pausado).
  - `pause(now: Date): boolean` — solo si corriendo; fija `pausedAt = now`; `false` (sin cambios) en otro caso.
  - `resume(now: Date, calendar: SlaCalendar): boolean` — solo si pausado; `dueAt = calendar.dueAt(now, calendar.workingMinutesBetween(pausedAt, dueAt))`, `pausedAt = null`.
  - `stop(now: Date, calendar: SlaCalendar): void` — acepta corriendo o pausado; si pausado, primero `resume(now, calendar)`; idempotente si ya no está abierto.
  - `markBreached` sin cambios de firma (sobre un pausado devuelve `false` porque `isRunning()` es falso).
  - `SlaTimerStatus = 'running' | 'paused' | 'met' | 'breached'`; `SlaTimerView` gana `pausedAt: Date | null`; `describeSlaTimer` recibe `pausedAt` y mide el margen contra `breachedAt ?? stoppedAt ?? pausedAt ?? now`.

- [ ] **Step 1: Tests** (reloj de 240 min arrancado a las 10:00, `dueAt` 14:00):
  - `pause(11:00)` → `isPaused()`, `!isRunning()`, `isOpen()`; segundo `pause` → `false`.
  - `resume(12:30, CALENDAR_24_7)` → `dueAt` 15:30, `pausedAt === null`; segundo `resume` → `false`.
  - `markBreached` sobre pausado → `false`, `breachedAt === null`.
  - `stop(13:00, CALENDAR_24_7)` sobre pausado desde 11:00 → `stoppedAt` 13:00, `dueAt` 16:00, `remainingMinutesAt(13:00) === 180`.
  - `pause` sobre incumplido o parado → `false`.
  - `describeSlaTimer` de un pausado desde 11:00 con `now` 20:00 → `status 'paused'`, `remainingMinutes 180`, `pausedAt` 11:00. Uno incumplido con `pausedAt` nulo sigue `'breached'`.
- [ ] **Step 2: Correr y ver que falla.**
- [ ] **Step 3: Implementar.** El comentario de `start` sobre `dueAt` "inmutable" pasa a decir: inmutable frente a cambios de POLÍTICA; solo lo mueve una pausa del propio ticket (ADR-0029).
- [ ] **Step 4: Correr** `corepack pnpm test -- sla` → PASS. `typecheck` señalará los llamadores de `stop(now)` y de `rehydrate`: se arreglan en las Tasks 5 y 6 (si bloquea, pasar `CALENDAR_24_7` provisionalmente en `StopSlaTimer`).
- [ ] **Step 5: Commit** `feat(sla): el reloj se puede pausar y reanudar sin contar la pausa`.

### Task 5: Migración, schema y repositorio con escrituras condicionadas

**Files:**
- Create: `prisma/migrations/20261112120000_waiting_on_customer/migration.sql`
- Modify: `prisma/schema.prisma` (enum `TicketStatus`, campo `pausedAt` en `SlaTimer`)
- Modify: `src/modules/ticketing/domain/ports/sla.repository.ts`
- Modify: `src/modules/ticketing/infrastructure/persistence/prisma-sla.repository.ts`
- Modify: `src/modules/ticketing/application/ticketing.test-doubles.ts` (`fakeSlaTimers`)
- Modify: `src/modules/ticketing/infrastructure/persistence/ticket.read-model.ts` (seleccionar `pausedAt` para `describeSlaTimer`)
- Test: e2e del repositorio dentro de `test/sla.e2e-spec.ts` (o una suite nueva `test/sla-pause.e2e-spec.ts`, que se amplía en la Task 9)

**Interfaces:**
- Consumes: Task 4.
- Produces (puerto `SlaTimerRepository`):
  - `save(timer)` — se mantiene SOLO para crear (lo usa `StartSlaTimers`); su rama `update` deja de existir o no actualiza nada.
  - `transition(timer: SlaTimer, expected: 'running' | 'paused'): Promise<boolean>` — `updateMany` por `id` + `tenantId` con `stoppedAt: null, breachedAt: null` y `pausedAt: null` (si `expected === 'running'`) o `pausedAt: { not: null }` (si `'paused'`); escribe `dueAt`, `pausedAt`, `stoppedAt`, `breachedAt` del timer; devuelve `count === 1`.
  - `findOpen(tenantId, ticketId, kind): Promise<SlaTimer | null>` — sustituye a `findRunning`; incluye los pausados.
  - `fakeSlaTimers` implementa `transition` con la misma condición y registra en `saved` solo las escrituras que aplicaron.

- [ ] **Step 1: Escribir la migración** (decisión 6 del spec): `ALTER TYPE "ticket_status" ADD VALUE 'WAITING_ON_CUSTOMER';` (sin usarlo en la migración); `ALTER TABLE "sla_timers" ADD COLUMN "paused_at" TIMESTAMP(3);`; `GRANT SELECT ("paused_at") ON "sla_timers" TO helpdesk_sla_sweeper;`; `CREATE OR REPLACE FUNCTION sla_due_timers(...)` idéntica a la de `20260909220000_sla` más `AND t.paused_at IS NULL`. Comentar en el SQL por qué va el GRANT (gotcha de la fase 8). El rol del barrido ya está en `DEFINER_ROLES` y la función no cambia de dueño.
- [ ] **Step 2: Schema** → `pausedAt DateTime? @map("paused_at")` y `WAITING_ON_CUSTOMER` en el enum. `corepack pnpm prisma generate`.
- [ ] **Step 3: Validar** en BD desechable: crearla, `prisma migrate deploy` contra ella, `prisma migrate diff --from-url <desechable> --to-schema-datamodel prisma/schema.prisma` → vacío; consultar `pg_proc` para confirmar que `sla_due_timers` sigue con OWNER `helpdesk_sla_sweeper`; borrar la BD. Después `corepack pnpm prisma:deploy` en la de desarrollo.
- [ ] **Step 4: Tests e2e del repositorio** (contra Postgres real): `transition(pausado, 'running')` aplica y devuelve `true`; una segunda `transition(..., 'running')` sobre la fila ya pausada devuelve `false` y no la cambia; marcar incumplido con `expected 'running'` un reloj pausado en BD devuelve `false`; `findOpen` devuelve el pausado; `sla_due_timers` no devuelve un reloj pausado aunque `due_at` haya pasado (llamada como `helpdesk_app`, que es como la usa el barrido). Correr → FAIL.
- [ ] **Step 5: Implementar** puerto, adapter (`toSlaTimer` mapea `pausedAt`), doble y read model. Renombrar los usos de `findRunning`.
- [ ] **Step 6: Correr** `corepack pnpm typecheck`, `corepack pnpm test`, y la suite e2e nueva → PASS.
- [ ] **Step 7: Commit** `feat(sla): paused_at en sla_timers y transiciones del reloj condicionadas`.

### Task 6: `StopSlaTimer` y `MarkSlaBreached` sobre escrituras condicionadas

**Files:**
- Modify: `src/modules/ticketing/application/sla/stop-sla-timer.use-case.ts`
- Modify: `src/modules/ticketing/application/sla/mark-sla-breached.use-case.ts`
- Test: `src/modules/ticketing/application/sla/sla-use-cases.spec.ts`

**Interfaces:**
- Consumes: Task 4 (`stop(now, calendar)`, `isOpen`, `isPaused`), Task 5 (`findOpen`, `transition`).
- Produces: sin cambios de firma pública. `StopSlaOutcome` igual; `MarkSlaBreachedOutcome` gana `reason: 'paused'` dentro de `skipped`, y `'not_running'` también cubre "otra escritura ganó la carrera" (cuando `transition` devuelve `false`).

- [ ] **Step 1: Tests**:
  - Stop sobre un reloj pausado desde 11:00 (240 min desde 10:00) con `occurredAt` 13:00 → `{ status: 'stopped', remainingMinutes: 180 }` y el reloj guardado parado.
  - Stop cuando `transition` devuelve `false` (doble preparado para fallar) → `skipped`, `no_running_timer`.
  - MarkSlaBreached sobre un reloj pausado vencido → `skipped`, `reason: 'paused'`, sin auditoría ni evento.
  - MarkSlaBreached cuando `transition` devuelve `false` → `skipped`, `'not_running'`, sin auditoría ni evento.
- [ ] **Step 2: Correr y ver que falla.**
- [ ] **Step 3: Implementar.** Stop: `findOpen`; anotar `expected = timer.isPaused() ? 'paused' : 'running'`; `timer.stop(occurredAt, CALENDAR_24_7)`; margen con `remainingMinutesAt(occurredAt)` DESPUÉS de parar; `transition(timer, expected)`. MarkSlaBreached: comprobar `isPaused()` antes de `isRunning()`; `markBreached` + `transition(timer, 'running')`; si devuelve `false`, salir sin auditar ni emitir.
- [ ] **Step 4: Correr** `corepack pnpm test -- sla` → PASS.
- [ ] **Step 5: Commit** `fix(sla): parar e incumplir no pisan una pausa concurrente`.

### Task 7: `SlaPauseCoordinator` dentro de `ChangeTicketStatus` y `AddComment`

**Files:**
- Create: `src/modules/ticketing/application/sla/sla-pause-coordinator.ts`
- Create: `src/modules/ticketing/application/sla/sla-pause-coordinator.spec.ts`
- Modify: `src/modules/ticketing/application/change-ticket-status.use-case.ts`
- Modify: `src/modules/ticketing/application/add-comment.use-case.ts`
- Modify: `src/modules/ticketing/ticketing.module.ts` (wiring por `useFactory`)
- Test: `src/modules/ticketing/application/change-ticket-status.use-case.spec.ts`, `src/modules/ticketing/application/add-comment.use-case.spec.ts`

**Interfaces:**
- Consumes: Task 2, Task 4, Task 5.
- Produces:
  - `class SlaPauseCoordinator { constructor(timers: SlaTimerRepository); onStatusChange(input: { tenantId: TenantId; ticketId: TicketId; from: TicketStatus; to: TicketStatus; now: Date }): Promise<'paused' | 'resumed' | 'none'> }`.
  - Regla: `to === 'WAITING_ON_CUSTOMER'` → pausar; `from === 'WAITING_ON_CUSTOMER' && to === 'IN_PROGRESS'` → reanudar con `CALENDAR_24_7`; resto (incluido `→ RESOLVED`, que lo para el consumidor) → `'none'`. Sin reloj abierto de `RESOLUTION`, o si `pause`/`resume`/`transition` devuelven `false` → `'none'`.
  - `ChangeTicketStatus` y `AddComment` reciben el coordinador como último parámetro del constructor.

- [ ] **Step 1: Tests del coordinador**: pausa con reloj corriendo; reanuda corriendo `dueAt` lo que duró la pausa; `RESOLVED` desde la espera → `'none'` y el reloj sigue pausado; sin reloj → `'none'`; reloj incumplido + paso a espera → `'none'` y sigue `breached`; espera (10:00) → retomar (10:05) → espera (10:06) → retomar (11:06): `dueAt` final corrido 65 min, no 66 (el minuto trabajado cuenta).
- [ ] **Step 2: Tests de los casos de uso**: `ChangeTicketStatus` a `WAITING_ON_CUSTOMER` deja el reloj pausado con `pausedAt === now`; si el cambio es ilegal (`OPEN → WAITING_ON_CUSTOMER`) el reloj no cambia. `AddComment` de un `VIEWER` público en espera: reloj reanudado, ticket en `IN_PROGRESS`, y DOS auditorías: `comment.added` (actor = autor) y `ticket.status_changed` con `actorId: SYSTEM_ACTOR_ID` y `metadata` `{ from: 'WAITING_ON_CUSTOMER', to: 'IN_PROGRESS', automatic: true, trigger: 'customer_reply', commentId }`. Nota interna en espera: una sola auditoría y reloj intacto.
- [ ] **Step 3: Correr y ver que falla.**
- [ ] **Step 4: Implementar.** En ambos casos de uso, comparar `from` con `ticket.status` después del cambio y, si difiere, llamar al coordinador con el mismo `now`, dentro de la transacción ya abierta (antes de `events.record`). Importar `SYSTEM_ACTOR_ID` del mismo sitio que `mark-sla-breached.use-case.ts`. Comentario en el coordinador explicando por qué es síncrono (decisión 5 del spec).
- [ ] **Step 5: Wiring** en `ticketing.module.ts`: proveer el coordinador con `useFactory` inyectando `SLA_TIMER_REPOSITORY` y pasarlo a las factories de los dos casos de uso. Arreglar los specs que construyen estos casos de uso (pasar `new SlaPauseCoordinator(fakeSlaTimers())`).
- [ ] **Step 6: Correr** `corepack pnpm test` y `corepack pnpm typecheck` → PASS.
- [ ] **Step 7: Commit** `feat(sla): pausar y reanudar en la misma transacción que el cambio de estado`.

### Task 8: API, consumidores y realtime

**Files:**
- Modify: `src/modules/ticketing/infrastructure/http/dto/ticket.dto.ts` (enum de estado; `SlaTimerDto` con `status` incluyendo `'paused'` y `pausedAt` nullable)
- Modify: `src/modules/ticketing/infrastructure/persistence/ticket.read-model.ts` (si no quedó hecho en Task 5)
- Revisar: `src/modules/ticketing/infrastructure/queue/sla.processor.ts`, `src/modules/ticketing/application/realtime/broadcast-ticket-event.use-case.ts`, `src/modules/ticketing/application/auto-assign-ticket.use-case.ts` y cualquier `switch` sobre `to`/`from` o sobre `TicketStatus`
- Test: specs existentes de esos consumidores

**Interfaces:**
- Consumes: Tasks 1, 4, 5.
- Produces: `PATCH /tickets/:id/status` acepta `WAITING_ON_CUSTOMER`; `GET /tickets/:id` → `sla[].status` puede ser `'paused'` y trae `pausedAt`; `GET /tickets?status=WAITING_ON_CUSTOMER` filtra.

- [ ] **Step 1: Tests** en el spec del procesador SLA: `status_changed` con `to: 'WAITING_ON_CUSTOMER'` y con `from: 'WAITING_ON_CUSTOMER', to: 'IN_PROGRESS'` → `{ action: 'ignored' }` (la pausa NO es del consumidor). En el de broadcast: un `status_changed` a la espera se difunde igual que cualquier otro.
- [ ] **Step 2: Correr**; si ya pasan, el valor nuevo no rompe nada y basta con dejar los tests. Si alguno falla, ajustar el consumidor.
- [ ] **Step 3: DTOs y Swagger** con el valor nuevo y `pausedAt`.
- [ ] **Step 4: Correr** `corepack pnpm test`, `corepack pnpm typecheck`, `corepack pnpm lint:ci` → PASS.
- [ ] **Step 5: Commit** `feat(tickets): la API expone la espera y el reloj en pausa`.

### Task 9: e2e de punta a punta

**Files:**
- Create o ampliar: `test/sla-pause.e2e-spec.ts` (con reloj inyectado vía `overrideProvider(CLOCK)`, igual que `test/sla.e2e-spec.ts`)

**Interfaces:**
- Consumes: todo lo anterior; helpers existentes de `test/sla.e2e-spec.ts` (`procesarSla`, barrido con `sweep(now)`).

- [ ] **Step 1: Escribir los escenarios** (política por defecto, ticket asignado y en `IN_PROGRESS`; avanzar el reloj entre acciones por el gotcha de `procesarSla`, y no depender del orden entre `comment.added` y el `status_changed` automático):
  1. Agente → `WAITING_ON_CUSTOMER`; avanzar más allá del `due_at` original; barrido → el reloj NO queda `breached` y `GET /tickets/:id` lo muestra `paused`. VIEWER comenta → ticket `IN_PROGRESS`, `due_at` corrido exactamente lo que duró la pausa; avanzar hasta el nuevo vencimiento → barrido → `breached`.
  2. Resolver desde la espera → tras procesar la cola `sla`, reloj `met` con margen que descuenta la pausa.
  3. Nota interna y comentario público de un AGENT en espera → sigue `WAITING_ON_CUSTOMER`, reloj `paused`.
  4. Espera → retomar → espera seguido → el tramo trabajado cuenta (comparar `due_at` final).
  5. `PATCH` a `CLOSED` y a `OPEN` desde la espera → 409. VIEWER que intenta `PATCH` a la espera → 403.
  6. `GET /tickets/:id/history` muestra el cambio automático con actor sistema.
- [ ] **Step 2: Correr** `corepack pnpm test:e2e` completo (Docker arrancado, sin `start:dev`) → todo en verde. Si falla el barrido de `sla.e2e-spec` por relojes viejos en la BD de desarrollo, es el gotcha conocido (CLAUDE.md, 2026-11-09), no este cambio.
- [ ] **Step 3: Commit** `test(e2e): pausa del SLA de punta a punta`.

### Task 10: ADRs y documentación del api

**Files:**
- Modify: `docs/ARCHITECTURE.md` (ADR-0029 nuevo + índice; adenda ADR-0015; revocación parcial ADR-0020 decisión 4; adenda ADR-0021)
- Modify: `README.md` (estados, carencias: "sin auto-resolver", "calendario solo 24/7")
- Modify: `CLAUDE.md` (decisiones locked + "Estado actual (2026-11-12)" + gotchas que hayan salido)

- [ ] **Step 1: ADR-0029** "Pausa del SLA: reloj pausable, vencimiento corrido y pausa en la transacción del cambio", con contexto, decisión, las dos alternativas descartadas (diferida con reconciliación, con el contraejemplo espera→retomar→espera; diferida blindada con columnas extra) y consecuencias (única excepción al patrón del consumidor; escrituras condicionadas; carrera aceptada barrido-vs-pausa). Mismo formato que ADR-0028.
- [ ] **Step 2: Adendas** en 0015, 0020 y 0021 enlazando al 0029.
- [ ] **Step 3: README y CLAUDE.md.**
- [ ] **Step 4: Verificación completa del api**: `corepack pnpm lint:ci`, `typecheck`, `test`, `test:e2e`, `build` → todo verde; anotar los números en CLAUDE.md.
- [ ] **Step 5: Commit** `docs: ADR-0029 pausa del SLA y adendas`.

### Task 11: Front (`helpdesk-web`)

**Files** (repo `helpdesk-web`, rama nueva `feat/esperando-al-cliente` desde `dev`):
- Modify: `src/lib/api/types.ts` (`TicketStatus`, `ALLOWED_TRANSITIONS` con las filas del spec, `SlaStatus` con `'paused'`, `pausedAt` en el tipo del reloj)
- Modify: `src/features/tickets/components/ticket-badges.tsx` (etiqueta "Esperando al cliente" con variante de color propia, distinta de `progress`)
- Modify: `src/app/(app)/tickets/page.tsx` (etiqueta del filtro por estado)
- Modify: `src/app/(app)/tickets/[id]/page.tsx` (etiquetas de acción: a la espera "Esperar al cliente"; desde la espera a `IN_PROGRESS` "Retomar")
- Modify: `src/features/tickets/components/sla-panel.tsx` (estado "En pausa": margen congelado y "en pausa desde <hora>", sin cuenta atrás)
- Test: `src/features/tickets/components/sla-panel.test.tsx`; test nuevo o ampliado para las acciones legales por estado

**Interfaces:**
- Consumes: contrato de la Task 8.

- [ ] **Step 1: Crear la rama** en `helpdesk-web` desde `dev`.
- [ ] **Step 2: Tests**: `SlaPanel` con un reloj `paused` muestra "En pausa" y el margen que viene de la API tal cual (no recalcula contra `Date.now()`); las acciones ofrecidas para `IN_PROGRESS` incluyen "Esperar al cliente" y para `WAITING_ON_CUSTOMER` son exactamente "Retomar" y la de resolver.
- [ ] **Step 3: Correr** `corepack pnpm test` → FAIL.
- [ ] **Step 4: Implementar** tipos, badge, etiquetas y panel. El comentario sobre `ALLOWED_TRANSITIONS` dice que es la copia de UX de la tabla del ADR-0015 y que se amplía a mano.
- [ ] **Step 5: Correr** `corepack pnpm test`, `corepack pnpm typecheck`, `corepack pnpm lint`, `corepack pnpm build` → PASS.
- [ ] **Step 6: Probar a mano** contra el api levantado (`start:dev`): mandar a espera, ver el panel en pausa, comentar como VIEWER en otra sesión y ver que vuelve solo a "En curso" por realtime.
- [ ] **Step 7: Actualizar** `helpdesk-web/CLAUDE.md` y el README si lista estados. **Commit** `feat(tickets): estado esperando al cliente y reloj en pausa`.

### Task 12: Cierre

- [ ] **Step 1:** Revisión de toda la rama en los dos repos (`superpowers:requesting-code-review`).
- [ ] **Step 2:** Actualizar la memoria del proyecto (`helpdesk-saas-project.md`) con commits, números de tests y gotchas.
- [ ] **Step 3:** Preguntarle a Marcos si mergear `feat/esperando-al-cliente` a `dev` (`--no-ff`) y pushear. **No hacerlo sin su OK.**
