# Horario laboral para el SLA — diseño

**Fecha:** 2026-11-13 · **Estado:** borrador para aprobar ·
**Repos:** `helpdesk-api` (calendario, SLA, configuración) + `helpdesk-web`
(pantalla de configuración y aviso al cliente) · **Cierra la tanda 1** del
plan de producto.

## Por qué

Hoy el SLA cuenta 24/7 (`CALENDAR_24_7`, ADR-0020 decisión 5). Un ticket
urgente que entra el viernes a las 17:00 con 4 h de respuesta vence el viernes
a las 21:00, con el equipo ya en su casa: el incumplimiento es del calendario,
no del equipo. Una organización real de soporte en Argentina trabaja con
turnos de 8 h (40–42 h semanales) cubriendo una franja de **8:00 a 18:00**, de
lunes a viernes, y **los feriados no se trabajan**.

## Qué es (en palabras del usuario)

Un **calendario de días hábiles por organización**: cada día es hábil o no
hábil; los fines de semana y los feriados son no hábiles. El reloj del SLA
solo avanza dentro del horario de los días hábiles. El cliente puede escribir
siempre ("mensajes en cola"): lo que manda fuera de horario queda guardado y
se atiende cuando abre la oficina, y **se le avisa** cuándo.

## Objetivos

1. **Calendario por organización** (cada tenant el suyo, aislado con RLS):
   - Semana tipo: días hábiles de la semana + hora de apertura y de cierre
     (una sola franja por día) + zona horaria IANA.
   - Valores por defecto: lunes a viernes, 08:00–18:00,
     `America/Argentina/Buenos_Aires`.
   - **Excepciones por fecha** que pisan la semana tipo: `no hábil` (feriado,
     aunque caiga martes) o `hábil` (p. ej. un sábado de cierre de mes, que
     usa la franja de la semana tipo). Cada una con un nombre ("Navidad").
2. **Feriados nacionales de Argentina precargables**: el ADMIN agrega con un
   botón los del año (lista estática en el código, por año), y después los
   edita o borra como cualquier otra excepción.
3. **El SLA usa el calendario de la organización del ticket** en los tres
   lugares que hoy reciben `CALENDAR_24_7`: arrancar relojes
   (`StartSlaTimers`), parar (`StopSlaTimer`, que reanuda antes de parar) y la
   reanudación de la pausa (`SlaPauseCoordinator`, ADR-0029). Es el "Revisar
   si" del ADR-0029: calendario del reloj, no uno global.
4. **Configuración solo ADMIN**: `GET|PUT /business-hours` (semana tipo) y
   alta/baja de excepciones, con auditoría en la misma transacción
   (mismo patrón que `sla.policy_changed`). Pantalla simple en
   `/settings/horario` del web: campos del horario + lista de excepciones.
5. **Aviso al cliente fuera de horario**: un endpoint para cualquier rol
   autenticado que devuelve SOLO `{ open: boolean, nextOpening: Date | null }`
   (nada de la configuración interna). El web muestra, al abrir un ticket o
   escribir en uno fuera de horario: "Estamos fuera de horario. Lo vamos a ver
   a partir del lunes 17/11 a las 8:00". Es un cartel en la pantalla, **no**
   un mensaje automático en la conversación.

## No objetivos (anotados en el ROADMAP para después)

- **Calendario visual** (ver el mes, clic en un día para marcarlo). El modelo
  de datos ya lo soporta: es solo otra pantalla sobre los mismos datos.
- Guardia 24/7 para urgentes: lo urgente también espera al próximo día hábil,
  con su objetivo más corto (inferido de la respuesta del usuario; él lo
  puede corregir al leer esto).
- Horarios por equipo o por agente, turnos partidos (mañana y tarde con corte
  al mediodía), franjas distintas por día de la semana.
- Mensaje automático en la conversación o por email (el email es tanda 2).
- Recalcular los relojes que ya están corriendo cuando cambia el horario.

## Anti-objetivos (fallaría aunque "funcione")

- **Un reloj que nunca vence.** Una semana sin días hábiles no se puede
  guardar; el cálculo de `dueAt` tiene un tope de búsqueda y falla fuerte en
  vez de colgarse si el calendario queda imposible (p. ej. todo un año de
  excepciones no hábiles).
- **Filtrar configuración interna al cliente.** El VIEWER solo ve "abierto o
  cerrado y cuándo abre", nunca la lista de excepciones ni el horario.
- **Romper en silencio a quien ya usa el sistema** (ver "Pendiente de
  decidir").
- **Un `dueAt` distinto según el servidor**: todo el cálculo se hace en la
  zona horaria guardada, nunca en la del proceso.

## Restricciones (vienen del proyecto)

- Hexagonal: el cálculo vive en el dominio (`ticketing/domain/sla/`) como un
  `SlaCalendar` nuevo construido a partir de la configuración; el dominio no
  importa Prisma ni Nest. El caso de uso obtiene el calendario de un puerto
  (p. ej. `BusinessCalendarProvider.forTenant(tenantId)`).
- Tablas nuevas con RLS ENABLE+FORCE y policies fail-closed como todas;
  `tenantId` siempre del JWT. Si el barrido o el publicador necesitan leerlas,
  GRANT por columna (gotcha de la fase 8).
- Sin dependencia nueva de zonas horarias si se puede: Node trae ICU completo
  y `Intl.DateTimeFormat` resuelve offsets de cualquier zona IANA. Argentina
  hoy no tiene horario de verano, pero el cálculo no debe suponerlo.
- `due_at` se sigue persistiendo y el barrido no cambia (compara `due_at` con
  ahora). El horario laboral solo cambia CÓMO se calcula `due_at`.
- ADR nuevo (**0034**) + adendas al ADR-0020 (decisión 5: el calendario deja
  de ser solo 24/7) y al ADR-0029 (la reanudación usa el calendario del
  tenant). Tests junto al código; e2e con reloj inyectado (`CLOCK`).
- Seed: `acme-support` con el calendario por defecto y los feriados del año.

## Decisiones tomadas en la conversación

- Una franja por organización, 8:00–18:00, lunes a viernes, Argentina — **del
  usuario**.
- Feriados configurables, no se trabajan — **del usuario**.
- Configurable por organización ("así aislamos los datos") — **del usuario**.
- El cliente escribe siempre y ve cuándo lo van a atender, como aviso en
  pantalla — **del usuario** (aceptó la propuesta).
- Ahora el dato completo con pantalla simple; calendario visual después —
  **del usuario** (preguntó si se podía agregar más adelante).

## Decisiones mías (revisables)

- Excepción `hábil` en un día no hábil usa la franja de la semana tipo (sin
  horario propio por excepción).
- Feriados precargados como **lista estática en el código, por año**, que se
  agregan con un botón; no una API externa (los trasladables cambian cada año
  y depender de un tercero en el cálculo del SLA es frágil).
- Cambiar el horario **no recalcula** relojes en marcha: aplica a los cálculos
  que vengan (relojes nuevos, reanudaciones, paradas). Coherente con el
  ADR-0020 decisión 4 (los cambios de política no tocan relojes vivos).
- Granularidad de minutos en apertura y cierre (HH:MM), con apertura < cierre.

## Pendiente de decidir

- **Qué calendario tienen las organizaciones que ya existen** y las que se
  registren a partir de ahora, si nadie lo configura: ¿el horario por defecto
  (8–18, L–V) desde el primer día, o 24/7 hasta que un ADMIN lo configure?

## Lo que queda a criterio de quien implemente

- Forma exacta de las tablas (una de configuración + una de excepciones es lo
  esperado) y de los DTOs.
- Algoritmo de `dueAt` / `workingMinutesBetween` (recorrer días hábiles es
  suficiente; el tope de búsqueda lo fija quien implemente con
  `SLA_MAX_MINUTES` como referencia).
- Cómo cachear el calendario por tenant dentro de una petición o job.
- Textos exactos de la pantalla y del aviso, siguiendo el tono del web.
