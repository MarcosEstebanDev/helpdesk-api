# UX de bandeja y detalle — diseño

**Fecha:** 2026-11-13 · **Estado:** mockup aprobado por el usuario ("mucho mejor,
se ve más dinámico"; "mejoralo lo más que puedas") ·
**Mockup:** https://claude.ai/artifact/CCx4Szw574hwuz7xzrGL6b ·
**Repos:** `helpdesk-api` (datos que la UI necesita) + `helpdesk-web`.

## Por qué

La bandeja era "puro etiquetas de colores": hasta 6 chips por fila, estado en
MAYÚSCULAS que se repite en todas, columna angosta, y lo que un agente más
necesita —qué vence primero— no estaba.

## Principio

**El color solo para lo que pide atención:** prioridad alta/urgente, SLA por
vencer o vencido, esperando al cliente. Todo lo demás neutro y en columnas
alineadas. Nada de MAYÚSCULAS en etiquetas visuales.

## Backend (lo que la UI necesita)

1. **`GET /tickets` trae, para el equipo** (al VIEWER, la clave no viaja —
   mismo criterio que `tags`):
   - `requesterEmail`: el email de quien abrió el ticket.
   - `slaSummary`: el reloj más urgente del ticket, resumido por una función
     pura del dominio (`summarizeSla`). **Regla revisada el 2026-11-13
     (opción B, tras la revisión de la rama): lo que todavía se puede
     salvar.** `{ state: 'running', dueAt }` con el vencimiento más próximo de
     los relojes vivos; si no, `{ state: 'paused' }`; solo si no queda
     ninguno vivo, `{ state: 'breached', since }` con el incumplimiento más
     viejo (un vencido sin marcar por el barrido cuenta igual); si el ticket
     está resuelto/cerrado o no tiene relojes abiertos, `{ state: 'none' }`.
     La primera versión decía "gana el incumplido", pero un reloj incumplido
     nunca se para: la fila quedaba en rojo hasta resolver aunque ya se
     hubiera respondido. Costo aceptado: una primera respuesta vencida y aún
     sin responder, con la resolución corriendo, se ve como "vence en…" en la
     bandeja; el incumplimiento sigue en el detalle.
2. **`GET /tickets/counts`** → `{ OPEN, IN_PROGRESS, WAITING_ON_CUSTOMER,
   RESOLVED, CLOSED }` con los MISMOS filtros que el listado salvo el estado
   (para que el número de cada pestaña sea lo que muestra al elegirla).
3. **`GET /tickets/:id/triage`** responde `{ status: 'disabled' }` cuando el
   servicio de IA no está configurado (hoy dice "pending" para siempre).

## Web

- **Bandeja:** pestañas de estado con número (Abiertos · En curso · Esperando
  al cliente · Resueltos · Todos); fila de filtros (Mis tickets, Etiquetas,
  IA); tabla con columnas N.º, Asunto (+ email del cliente), Etiquetas (punto
  de color + nombre, máx. 2 y "+N"), Asignado (iniciales; el tuyo con anillo),
  Estado (punto + texto), SLA ("vence en 40 min" ámbar si faltan < 2 h,
  "vencido hace 1 h" rojo, "en pausa"), Actualizado (una línea, fecha exacta
  en el `title`). Barra de prioridad a la izquierda solo para alta/urgente. La
  IA aparece junto al asunto solo si sugiere más urgencia. Teclado: `j`/`k`
  mueven, Enter abre. En pantallas chicas la fila es una tarjeta.
- **Barra lateral:** vistas agrupadas en "Vistas del equipo" y "Mis vistas".
- **Detalle:** cabecera con el asunto, quién lo abrió y las acciones de estado
  a la vista (Esperar al cliente / Resolver / Retomar…); conversación tipo
  chat (cliente a la izquierda, equipo a la derecha, nota interna centrada en
  ámbar con candado) con los cambios de estado intercalados (solo equipo:
  salen del historial); caja de respuesta con "Responder y esperar al
  cliente"; panel con el SLA primero (barra de progreso), datos en columnas,
  etiquetas e IA ("no disponible" cuando está apagada).
- Esqueletos de carga con la forma de la tabla; estados vacíos que dicen qué
  hacer.

## Fuera de alcance

Tema claro rediseñado (se mantiene el actual), ordenar columnas, columnas
configurables, edición en línea desde la bandeja.

## Restricciones

Mismos permisos de siempre (nada interno al VIEWER); unit, e2e completos,
lint, typecheck; web tests, tsc, lint, build.
