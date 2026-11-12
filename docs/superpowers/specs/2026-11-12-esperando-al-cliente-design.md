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
- Duplicar la regla de transiciones en el front o en el motor de SLA: sigue
  habiendo UNA tabla (`domain/ticket-status.ts`).
- Guardar un campo `status` en el reloj: el estado se sigue DERIVANDO de fechas.

## Restricciones (del proyecto)

- Hexagonal; dominio y aplicación puros. Metodología: ADR del "por qué" en
  `docs/ARCHITECTURE.md`, tests junto al código, commitear pronto (OneDrive ya
  revirtió el árbol una vez).
- Todos los cambios de estado pasan por `Ticket.changeStatus` (único camino).
- Los relojes los mueve el **consumidor del outbox** (cola `sla`), fechando con
  el `occurredAt` del evento, no con la hora del job (ADR-0020/0021).
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
- El cambio automático queda en el AuditLog como cualquier transición, con
  `metadata.trigger = 'customer_reply'` y el id del comentario (decisión de Claude).

### 3. Modelo de la pausa en `SlaTimer`

- Columna nueva `sla_timers.paused_at timestamp(3) NULL`. Sin otros campos.
- Estados derivados: **corriendo** (sin parar, sin incumplir, sin pausa),
  **en pausa** (`paused_at` no nulo), **cumplido**, **incumplido**. `SlaTimerStatus`
  pasa a `'running' | 'paused' | 'met' | 'breached'`. `isRunning()` excluye los
  pausados, así `markBreached` sobre un pausado devuelve `false` sin cambios.
- `pause(now)`: solo si corriendo; idempotente.
- `resume(now, calendar)`: corre `due_at` hacia adelante lo que duró la pausa y
  limpia `paused_at`; idempotente si no está pausado.
- `stop(now)` sobre un reloj pausado (resolver desde la espera): primero aplica
  la reanudación lógica (corre `due_at`) y después para. Resultado: el margen
  mostrado descuenta la pausa.
- `describeSlaTimer`: para un pausado, `remainingMinutes` se mide contra
  `paused_at` (congelado), igual que hoy un parado se mide contra `stopped_at`.
- Se sigue persistiendo un único `due_at` "efectivo"; no se guarda el original.

### 4. Calendario (costura para el horario laboral)

- **Decisión de Claude:** `SlaCalendar` gana `workingMinutesBetween(from, to)`.
  La reanudación hace `restante = calendar.workingMinutesBetween(pausedAt, dueAt)`
  y `dueAt = calendar.dueAt(now, restante)`. En 24/7 equivale a sumar la duración
  de la pausa, pero así el horario laboral no obliga a tocar la pausa después.
- El calendario que usa la reanudación es el mismo que usó el arranque (hoy
  siempre `CALENDAR_24_7`).

### 5. Quién mueve los relojes

En `sla.processor.ts`, `onStatusChanged` deja de ignorar todo lo que no sea
`RESOLVED`:

| Evento `ticket.status_changed` | Acción sobre `RESOLUTION` |
|---|---|
| `to = WAITING_ON_CUSTOMER` | `PauseSlaTimer` |
| `from = WAITING_ON_CUSTOMER`, `to = IN_PROGRESS` | `ResumeSlaTimer` |
| `to = RESOLVED` (desde cualquier estado) | `StopSlaTimer` existente (ya contempla pausado) |
| resto | ignorado, como hoy |

- Casos de uso nuevos `PauseSlaTimer` y `ResumeSlaTimer`, con idempotencia por
  `processed_messages` (consumer `sla.pause:RESOLUTION` / `sla.resume:RESOLUTION`,
  mismo patrón que `StopSlaTimer`) y fechados con `occurredAt`.
- **Desorden de eventos:** la cola `sla` usa concurrencia 1 (default de BullMQ) y
  el publicador saca en orden, así que pausa→reanudación llega en orden en una
  instancia. Para que un desorden (varias instancias, reintentos) no deje un reloj
  pausado para siempre, **los dos casos de uso reconcilian contra el estado ACTUAL
  del ticket** dentro de la transacción: solo pausan si el ticket sigue en
  `WAITING_ON_CUSTOMER` y solo reanudan si ya no lo está. Peor caso aceptado: en
  un desorden se pierde la pausa (cuenta contra el SLA), nunca se queda pausado.
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

- **ADR-0029** "Pausa del SLA: reloj pausable, vencimiento corrido y
  reconciliación contra el ticket" + adenda al ADR-0015 (tabla) y al ADR-0020
  (estado `paused`). Actualizar README (tabla de estados / carencias) y los
  CLAUDE.md de ambos repos.

## Pruebas que importan

- Dominio: recorrido exhaustivo de la tabla de transiciones; `SlaTimer`
  pausar/reanudar/idempotencia, `stop` sobre pausado (margen sin la pausa),
  `markBreached` sobre pausado = false, `describeSlaTimer` congelado;
  `registerComment` con las 4 combinaciones (staff/no staff × PUBLIC/INTERNAL)
  en espera, y que fuera de la espera no cambia el estado.
- Calendario: `workingMinutesBetween` del 24/7.
- Casos de uso Pause/Resume: idempotencia por evento repetido y reconciliación
  (pausa que llega cuando el ticket ya no espera → no pausa).
- e2e con **reloj inyectado** (`overrideProvider(CLOCK)`): agente manda a espera →
  avanza el reloj más allá del vencimiento → el barrido NO incumple → el VIEWER
  comenta → ticket en `IN_PROGRESS` y `due_at` corrido exactamente lo que duró la
  pausa → avanzar hasta el nuevo vencimiento → incumple. Más: resolver desde la
  espera; nota interna en espera no lo saca.
- Migración desde cero en BD desechable sin drift, y el barrido funcionando con
  el rol `helpdesk_sla_sweeper` (cubre el GRANT por columna).
- Front: badge, acciones legales por estado, panel "en pausa".

## Qué queda a criterio de quien construye

- Nombres exactos de métodos, archivos, migración y textos de UI.
- Si `PauseSlaTimer`/`ResumeSlaTimer` son dos casos de uso o uno con modo.
- Orden de commits (recomendado: dominio → migración+infra → processor → API → front).
- Color del badge y redacción del panel de pausa.
