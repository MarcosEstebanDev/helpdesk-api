# Diseño — Estado "esperando al cliente" que pausa el SLA

Fecha: 2026-11-12 · Tanda 1 del plan de producto (2026-11-11) · Repos: `helpdesk-api` y `helpdesk-web`

## Intención y por qué

Hoy, cuando un agente necesita algo del solicitante (un dato, una captura, que
pruebe algo), el ticket sigue en `IN_PROGRESS` y el reloj de resolución sigue
corriendo. El SLA penaliza al equipo por tiempo que depende del cliente, y el
agente no tiene forma de decir "la pelota está del otro lado".

El comportamiento buscado es **el de Zendesk** (decisión de Marcos): el agente
pasa el ticket a "esperando al cliente"; mientras está ahí el reloj de
resolución **no corre**; cuando el solicitante contesta, el ticket **vuelve solo**
a `IN_PROGRESS` y el reloj se reanuda, sin que nadie lo mueva a mano.

Es un proyecto de portfolio cuyo objetivo es mostrar decisiones de arquitectura:
la pieza interesante es cómo pausar un reloj cuyo vencimiento está persistido y
barrido por un proceso aparte, sin romper ninguna de las garantías actuales
(estado derivado de fechas, idempotencia por condición, barrido sin bloqueos).

## Objetivos

1. Nuevo estado `WAITING_ON_CUSTOMER` en la máquina de estados (ADR-0015).
2. Entrar en ese estado pausa el reloj de `RESOLUTION`; salir lo reanuda, y el
   tiempo pausado **no cuenta**: el vencimiento se corre lo que duró la pausa.
3. Un comentario **público** de alguien que **no es del equipo** sobre un ticket
   en espera lo devuelve a `IN_PROGRESS` automáticamente.
4. Un reloj pausado nunca se marca incumplido, y el front lo muestra como
   "en pausa" con el margen congelado, no como un margen que baja.
5. Front: el agente puede mandar a espera y retomar; el estado se ve en la
   bandeja, en el detalle y en el filtro por estado.

## No objetivos (explícitos)

- **Auto-resolver tras N días sin respuesta.** Decisión de Claude, aceptada por
  Marcos: un ticket en espera queda así sin límite; el auto-resolver entra con las
  automatizaciones de la Tanda 3.
- **Horario laboral.** Es la siguiente pieza de la Tanda 1, con su propio diseño.
  Este diseño solo deja la costura lista (ver "Calendario").
- **Pausar el reloj de RESPUESTA.** Solo se pausa `RESOLUTION`.
- **Rol CLIENTE / portal y avisos por email al cliente.** Tanda 2.
- Métricas de "tiempo total en espera" (reporting). Tanda 3.

## Anti-objetivos (sería un fracaso aunque funcione)

- Que el barrido marque incumplido un ticket que estuvo en pausa (el bug obvio de
  pausar sin tocar `due_at` o sin filtrar en `sla_due_timers`).
- Que el cliente pueda "despausar" o manipular el SLA con notas internas o que el
  equipo lo saque de la espera comentando: solo lo saca el solicitante (o un
  agente a mano).
- Duplicar la regla de transiciones en el motor de SLA: la regla vive en UNA
  tabla (`domain/ticket-status.ts`). El front YA tiene una copia de UX en
  `helpdesk-web/src/lib/api/types.ts` (comentada como "UX, no validación"); se
  amplía a mano, reconociendo la duplicación existente, sin crear otra nueva.
- Guardar un campo `status` en el reloj: el estado se sigue DERIVANDO de fechas.

## Restricciones (del proyecto)

- Hexagonal; dominio y aplicación puros. Metodología: ADR del "por qué" en
  `docs/ARCHITECTURE.md`, tests junto al código, commitear pronto (OneDrive ya
  revirtió el árbol una vez).
- Todos los cambios de estado pasan por `Ticket.changeStatus` (único camino).
- Hasta hoy los relojes los mueve el **consumidor del outbox** (cola `sla`),
  fechando con el `occurredAt` del evento (ADR-0020/0021). **Este diseño hace una
  excepción deliberada para pausar/reanudar** (decisión 5, elegida por Marcos).
- Gotchas que aplican directamente: un `GRANT SELECT` por columna no alcanza a
  columnas nuevas; `CREATE OR REPLACE FUNCTION` no puede cambiar el tipo de
  retorno; un valor nuevo de un enum (`ALTER TYPE ... ADD VALUE`) no se puede
  USAR en la misma transacción que lo crea; validar migraciones en BD desechable,
  nunca `migrate reset`.

## Decisiones

### 1. Máquina de estados

```
OPEN                -> IN_PROGRESS | RESOLVED
IN_PROGRESS         -> RESOLVED    | OPEN | WAITING_ON_CUSTOMER   (nuevo)
WAITING_ON_CUSTOMER -> IN_PROGRESS | RESOLVED                     (nuevo)
RESOLVED            -> CLOSED      | OPEN
CLOSED              -> (terminal)
```

- Solo se entra desde `IN_PROGRESS` (hay alguien trabajándolo). Se sale a
  `IN_PROGRESS` (respuesta del cliente o un agente que lo retoma) o a `RESOLVED`
  (el cliente avisó por otro canal "ya está"). No a `CLOSED` directo ni a `OPEN`.
- Permisos: los mismos que cualquier cambio de estado hoy (AGENT, `@MinRole`).
- Se amplía el ADR-0015 (tabla y comentario), no se escribe uno nuevo para esto.

### 2. Vuelta automática a `IN_PROGRESS`

- La decide el **agregado `Ticket`**, dentro de la misma transacción que el
  comentario: `registerComment` comprueba "estoy en `WAITING_ON_CUSTOMER`, el
  comentario es `PUBLIC` y el autor NO es del equipo (`!isResponder(authorRole)`)"
  y, si se cumple, llama a `changeStatus('IN_PROGRESS', now)`. Así emite el
  `ticket.status_changed` normal y el SLA no necesita una regla propia para
  comentarios.
- **Decisión de Claude:** "del solicitante" = cualquier autor que no sea staff, no
  exclusivamente `requesterId`. Es la misma frontera que ya usa
  `countsAsResponse`, y con el rol CLIENTE de la Tanda 2 sigue valiendo. (Un
  agente que abrió el ticket en nombre de alguien no lo saca de la espera
  comentando, porque es staff — correcto: comentar no es "el cliente respondió".)
- **Auditoría (decisión de Claude):** hoy la auditoría la escribe el CASO DE USO,
  no el agregado (`AddComment` solo registra `comment.added`). Así que
  `AddComment` detecta que el ticket cambió de estado (comparando el estado antes
  y después de `registerComment`) y registra además un `ticket.status_changed`
  con actor **`SYSTEM_ACTOR_ID`**, `automatic: true`, `trigger: 'customer_reply'`
  y el `commentId` en `metadata` — el mismo patrón que la auto-asignación. El
  autor del comentario queda en el registro del comentario.

### 3. Modelo de la pausa en `SlaTimer`

- Columna nueva `sla_timers.paused_at timestamp(3) NULL`. Sin otros campos.
- Estados derivados: **corriendo** (sin parar, sin incumplir, sin pausa),
  **en pausa** (`paused_at` no nulo), **cumplido**, **incumplido**. `SlaTimerStatus`
  pasa a `'running' | 'paused' | 'met' | 'breached'`. `isRunning()` excluye los
  pausados, así `markBreached` sobre un pausado devuelve `false` sin cambios.
- `pause(now)`: solo si corriendo; idempotente.
- `resume(now, calendar)`: corre `due_at` hacia adelante lo que duró la pausa y
  limpia `paused_at`; idempotente si no está pausado.
- `stop(now)` sobre un reloj pausado (resolver desde la espera). **Esto NO
  funciona hoy y hay que cambiarlo:** `stop()` sale sin hacer nada si
  `!isRunning()`, y con `isRunning()` excluyendo los pausados un reloj pausado no
  pararía nunca (quedaría pausado para siempre, ni cumplido ni incumplido).
  `stop()` pasa a aceptar corriendo O pausado: si está pausado, primero aplica
  la reanudación (corre `due_at`) y después para. Y en `StopSlaTimer` el margen
  (`remainingMinutesAt(occurredAt)`) se calcula DESPUÉS de esa corrección, no
  antes como hoy. Resultado: el margen descuenta la pausa.
- `describeSlaTimer`: para un pausado, `remainingMinutes` se mide contra
  `paused_at` (congelado), igual que hoy un parado se mide contra `stopped_at`.
- Se sigue persistiendo un único `due_at` "efectivo"; no se guarda el original.
  **Esto revoca parte del ADR-0020 (decisión 4, "`due_at` inmutable")** y el
  ADR-0029 lo dice explícitamente. El motivo de aquella regla era que cambiar la
  POLÍTICA no tocara relojes en marcha, y eso se sigue cumpliendo: `due_at` solo
  se mueve por una pausa del propio ticket, nunca por un cambio de política. El
  objetivo original se puede reconstruir desde el AuditLog (las transiciones
  hacia y desde la espera quedan fechadas); el reporting de la Tanda 3 lo
  tendrá que hacer así o añadir una columna entonces (decisión de Claude: no
  añadirla ahora).

### 4. Calendario (costura para el horario laboral)

- **Decisión de Claude:** `SlaCalendar` gana `workingMinutesBetween(from, to)`.
  La reanudación hace `restante = calendar.workingMinutesBetween(pausedAt, dueAt)`
  y `dueAt = calendar.dueAt(now, restante)`. En 24/7 equivale a sumar la duración
  de la pausa, pero así el horario laboral no obliga a tocar la pausa después.
- El calendario que usa la reanudación es el mismo que usó el arranque (hoy
  siempre `CALENDAR_24_7`).

### 5. Quién mueve los relojes — pausa SÍNCRONA (opción A, elegida por Marcos)

**Pausar y reanudar se hacen en la MISMA transacción que el cambio de estado**,
no en el consumidor del outbox. `ChangeTicketStatus` (entrar/salir a mano) y
`AddComment` (vuelta automática) cargan el reloj de `RESOLUTION` del ticket y lo
pausan o reanudan con el mismo `now` del cambio, antes del commit.

Por qué (va al ADR-0029): la opción diferida tenía dos fallos reales que
encontró la revisión del diseño.
1. Espera → `IN_PROGRESS` → espera antes de que el worker procese: reconciliar
   contra el estado actual del ticket contaba como pausa el tramo trabajado (el
   error favorecía al equipo).
2. Una pausa procesada tarde llegaba después de que el barrido marcara un
   incumplimiento definitivo, y pausa y barrido se pisaban (upsert sin condición).

Arrancar y parar un reloj toleran retraso (se fechan con `occurredAt` y nadie
decide nada con el reloj mientras tanto); **pausar no**, porque el barrido usa ese
dato para decidir un incumplimiento irreversible. Por eso es la única excepción
al patrón del consumidor, y no se extiende a arrancar ni a parar.

Consecuencias:
- La lógica vive en un servicio de aplicación (p. ej. `SlaPauseCoordinator`) que
  usan los dos casos de uso: dado el estado anterior y el nuevo, decide pausar,
  reanudar o nada. Sin `processed_messages`: va en la transacción del cambio, no
  hay reentrega posible.
- Un ticket sin reloj de `RESOLUTION` (o con el reloj ya parado/incumplido) no es
  un error: no se hace nada.
- **El consumidor `sla` NO cambia** para la pausa: `onStatusChanged` sigue
  ignorando las transiciones a/desde `WAITING_ON_CUSTOMER` y solo actúa en
  `to = RESOLVED`, que ahora también para un reloj pausado (ver decisión 3).
- **Escrituras condicionadas.** Hoy `PrismaSlaRepository.save` es un upsert por
  `id` sin condición, y `MarkSlaBreached` lee y luego escribe, así que una pausa y
  el barrido simultáneos se pisan. Las transiciones del reloj pasan a ser
  `UPDATE ... WHERE` condicionados (incumplir solo
  `WHERE stopped_at IS NULL AND breached_at IS NULL AND paused_at IS NULL`;
  pausar solo `WHERE stopped_at IS NULL AND breached_at IS NULL AND paused_at IS NULL`;
  reanudar solo `WHERE paused_at IS NOT NULL`), devolviendo si afectaron una
  fila. Es lo que el ADR-0021 ya prometía ("idempotencia por condición, no por
  bloqueo") y el repositorio no cumplía. Sin `FOR UPDATE`.
- Carrera restante, aceptada: si el barrido incumple en el mismo instante en que
  el agente pausa, gana quien escribe primero; si gana el barrido es porque el
  reloj de verdad ya había vencido antes de la pausa, y el incumplimiento es
  correcto.
- `ticket.status_changed` sigue en **v1**: el payload no cambia, solo aparece un
  valor nuevo del enum. Revisar los demás consumidores que miran `to`/`from`
  (realtime, routing) para que el valor nuevo no caiga en una rama inesperada.

### 6. Barrido y migración

- Migración nueva (nombre orientativo `20261112120000_waiting_on_customer`):
  1. `ALTER TYPE ticket_status ADD VALUE 'WAITING_ON_CUSTOMER'` (sin usarlo en la
     misma migración).
  2. `ALTER TABLE sla_timers ADD COLUMN paused_at timestamp(3)`.
  3. `GRANT SELECT (paused_at) ON sla_timers TO helpdesk_sla_sweeper` — sin esto
     el barrido deja de funcionar ENTERO con 42501.
  4. `CREATE OR REPLACE FUNCTION sla_due_timers(...)` con `AND t.paused_at IS NULL`
     (mismo tipo de retorno → `OR REPLACE` sirve y conserva OWNER y GRANTs;
     comprobarlo igual).
- `schema.prisma` acompaña (enum + campo) y `prisma migrate diff` debe dar cero.

### 7. API y realtime

- `PATCH /tickets/:id/status` acepta el valor nuevo; Swagger/DTOs con el enum.
- `GET /tickets/:id` → `sla[]` con `status: 'paused'` y `pausedAt`.
- `GET /tickets` filtra por el estado nuevo como por cualquier otro.
- Realtime: `ticket.status_changed` ya se difunde; no hay evento nuevo. La vuelta
  automática por comentario del cliente le llega al equipo por ese mismo aviso.

### 8. Front (`helpdesk-web`)

- Etiqueta y badge "Esperando al cliente" (color propio, distinto de "En progreso").
- Detalle: acción "Esperar al cliente" (desde En progreso) y "Retomar" (desde la
  espera), saliendo de las transiciones legales que ya replica la UX.
- Panel de SLA: estado "En pausa" con el margen congelado y desde cuándo.
- Filtro de la bandeja por el estado nuevo.
- Los tipos de `src/lib/api/types.ts` se amplían a mano (el cliente desde OpenAPI
  sigue sin generarse).

### 9. Documentación

- **ADR-0029** "Pausa del SLA: reloj pausable, vencimiento corrido y pausa en la
  transacción del cambio" (con las dos alternativas descartadas: diferida con
  reconciliación y diferida blindada con columnas extra) + adenda al ADR-0015
  (tabla), revocación parcial explícita del ADR-0020 decisión 4 (`due_at`
  inmutable) y adenda al ADR-0021 (escrituras condicionadas en el repositorio). Actualizar README (tabla de estados / carencias) y los
  CLAUDE.md de ambos repos.

## Pruebas que importan

- Dominio: recorrido exhaustivo de la tabla de transiciones; `SlaTimer`
  pausar/reanudar/idempotencia, `stop` sobre pausado (margen sin la pausa),
  `markBreached` sobre pausado = false, `describeSlaTimer` congelado;
  `registerComment` con las 4 combinaciones (staff/no staff × PUBLIC/INTERNAL)
  en espera, y que fuera de la espera no cambia el estado.
- Calendario: `workingMinutesBetween` del 24/7.
- Coordinador de pausa: cada par (estado anterior, nuevo) → pausar/reanudar/nada;
  ticket sin reloj o con reloj parado/incumplido → nada.
- `ChangeTicketStatus` y `AddComment`: el reloj queda pausado/reanudado en la
  misma transacción, y si el caso de uso falla (rollback) el reloj no cambia.
- Repositorio: las escrituras condicionadas no pisan (incumplir un pausado no
  afecta filas; pausar un incumplido tampoco).
- `StopSlaTimer` sobre un reloj pausado: queda parado y su margen descuenta la
  pausa.
- e2e con **reloj inyectado** (`overrideProvider(CLOCK)`): agente manda a espera →
  avanza el reloj más allá del vencimiento → el barrido NO incumple → el VIEWER
  comenta → ticket en `IN_PROGRESS` y `due_at` corrido exactamente lo que duró la
  pausa → avanzar hasta el nuevo vencimiento → incumple. Más: resolver desde la
  espera; nota interna en espera no lo saca; espera → retomar → espera seguido
  (el tramo trabajado SÍ cuenta). Ojo: `comment.added` y el `status_changed`
  automático salen con el mismo `occurredAt` y el orden entre ellos en el outbox
  es arbitrario; el e2e no debe depender de él (gotcha de `procesarSla`).
- Migración desde cero en BD desechable sin drift, y el barrido funcionando con
  el rol `helpdesk_sla_sweeper` (cubre el GRANT por columna).
- Front: badge, acciones legales por estado, panel "en pausa".

## Qué queda a criterio de quien construye

- Nombres exactos de métodos, archivos, migración y textos de UI.
- Si `PauseSlaTimer`/`ResumeSlaTimer` son dos casos de uso o uno con modo.
- Orden de commits (recomendado: dominio → migración+infra → processor → API → front).
- Color del badge y redacción del panel de pausa.
