# UX de bandeja y detalle — Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans.

**Spec:** `docs/superpowers/specs/2026-11-13-ux-bandeja-detalle-design.md` · **Mockup:** https://claude.ai/artifact/CCx4Szw574hwuz7xzrGL6b

## Global Constraints
- Datos nuevos del listado (`requesterEmail`, `slaSummary`) solo para AGENT+; al VIEWER la clave no viaja.
- `GET /tickets/counts` usa los mismos filtros que el listado salvo `status`.
- Sin MAYÚSCULAS en etiquetas visuales; color solo para prioridad alta/urgente, SLA por vencer/vencido y esperando al cliente.
- Commits con `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. No correr e2e con `start:dev` arriba.

## Review Focus
1. Un VIEWER no recibe `requesterEmail` ni `slaSummary` en el listado. (e2e T2)
2. Un ticket resuelto con un reloj incumplido muestra `none`, no "vencido". (unit T1)
3. Las pestañas suman lo mismo que muestran: `counts.IN_PROGRESS` = largo de `?status=IN_PROGRESS` con los mismos filtros (búsqueda incluida). (e2e T2)
4. `j`/`k`/Enter no se disparan mientras se escribe en la búsqueda. (web T5)
5. "Responder y esperar al cliente" con un error al comentar no cambia el estado. (web T6)

---

### T1 — Dominio: `summarizeSla(status, timers, now)` (+unit).
### T2 — Read model + HTTP: `requesterEmail`, `slaSummary` (solo equipo), `GET /tickets/counts`, triage `disabled` (+e2e).
### T3 — Docs (README endpoints, CLAUDE.md).
### T4 (web) — Datos: tipos, api/queries de counts, `formatoSla` puro (+tests).
### T5 (web) — Bandeja: pestañas con números, fila de filtros, tabla, tarjetas en móvil, teclado, esqueleto, barra lateral agrupada (+tests).
### T6 (web) — Detalle: cabecera con acciones, chat con eventos de estado, "Responder y esperar al cliente", panel con SLA primero e IA "no disponible" (+tests).
### Verificación final — e2e completos, build, revisión fresca (opus), demo en Chrome, preguntar antes de mergear.
