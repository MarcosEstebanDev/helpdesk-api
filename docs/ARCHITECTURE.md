# Architecture

Helpdesk SaaS — multi-tenant, event-driven. Este documento registra las
decisiones de arquitectura como **ADRs** (Architecture Decision Records). Cada
ADR explica el contexto, la decisión y las consecuencias.

> Estado de los ADRs: `Accepted` salvo indicación. Algunos describen patrones que
> se implementan en fases posteriores (se anota la fase).

---

## ADR-0001 — Repos separados (no monorepo)

**Contexto.** Backend (NestJS) y frontend (Next.js) podrían vivir en un monorepo.
**Decisión.** Dos repos independientes: `helpdesk-api` y `helpdesk-web`.
**Consecuencias.** (+) Ciclos de vida, CI y despliegues desacoplados; cada repo
con su tooling. (−) Se pierde el paquete de tipos compartido del monorepo → se
resuelve compartiendo el contrato vía OpenAPI (ADR-0004).

## ADR-0002 — Arquitectura hexagonal (ports & adapters) con regla de dependencias de Clean

**Contexto.** El proyecto debe mostrar separación de responsabilidades y testabilidad.
**Decisión.** Capas `domain → application → infrastructure` con la dependencia
apuntando siempre hacia el dominio. Organización por **bounded context** en
`src/modules/*`. Puertos = interfaces en `domain`; adapters en `infrastructure`,
inyectados en Nest por token.
**Consecuencias.** (+) Dominio puro y testeable sin mocks; cambiar Prisma/transport
no toca el dominio; camino claro a microservicios (modular monolith). (−) Más
boilerplate (mappers, tokens de DI) que un CRUD acoplado.

## ADR-0003 — Multi-tenancy con PostgreSQL Row-Level Security (row-level)

**Contexto.** Aislamiento de datos entre organizaciones (tenants).
**Decisión.** Un solo esquema con `tenant_id` por fila y **RLS** como última línea
de defensa. NO schema-per-tenant.
**Detalles de implementación (fase 2).**
- El rol de la app **no es dueño de las tablas** y **no tiene `BYPASSRLS`**; `FORCE ROW LEVEL SECURITY` en cada tabla.
- Cada request corre dentro de una transacción Prisma que setea
  `SELECT set_config('app.current_tenant', $1, true)` (parametrizado; nunca concatenado).
- El `tenant_id` proviene SIEMPRE del JWT autenticado (interceptor + AsyncLocalStorage), nunca del cliente.
**Consecuencias.** (+) Aunque el código tenga un bug y olvide filtrar, la DB
rechaza el cross-tenant (test e2e lo prueba). (−) Cuidado con connection pooling
en modo transacción: `SET LOCAL` debe vivir dentro de su transacción.

## ADR-0004 — Contratos vía OpenAPI

**Contexto.** Sin monorepo, back y front pueden desincronizar tipos.
**Decisión.** NestJS expone el spec OpenAPI (Swagger en `/docs`); el front genera
su cliente tipado desde ese spec (`openapi-typescript`).
**Consecuencias.** (+) Contrato único, cero acoplamiento de repos. (−) Hay que
mantener decorados los DTOs; los eventos WebSocket (no REST) se tipan aparte (fase 7).

## ADR-0005 — Errores como valores (`Result`) en domain/application

**Contexto.** Los errores de negocio son flujo esperado, no excepcional.
**Decisión.** Domain y application devuelven `Result<T, E>` (`src/shared-kernel/domain/result.ts`).
Las excepciones quedan para fallos técnicos y se mapean a HTTP en los bordes
(formato `application/problem+json`, RFC 7807).
**Consecuencias.** (+) Errores explícitos en el tipo, control de flujo claro. (−) Más verboso que `throw`.

## ADR-0006 — Branded types para IDs

**Contexto.** En un sistema multi-tenant, mezclar un `userId` con un `tenantId` es
una fuga de datos.
**Decisión.** IDs como tipos branded (`Brand<string, 'TenantId'>`, ver
`src/shared-kernel/domain/branded-id.ts`); el compilador impide pasar el id equivocado.
**Consecuencias.** (+) Seguridad por diseño en tiempo de compilación. (−) Hay que
"brandear" en los bordes (mappers).

## ADR-0007 — Transactional outbox para publicar eventos

**Contexto.** Publicar a BullMQ después de commitear puede perder eventos si el
proceso muere entre el commit y el publish; publicar antes puede emitir eventos de
transacciones que luego fallan (sobre todo con RLS).
**Decisión (fase 5).** Los agregados registran domain events; el cambio de estado y
el registro del evento en una tabla `outbox` ocurren **en la misma transacción**.
Un publisher lee la outbox y encola en BullMQ.
**Consecuencias.** (+) Entrega confiable (at-least-once) + idempotencia en los
handlers ⇒ efectivamente once. (−) Componente extra (relay/publisher).

## ADR-0008 — CQRS-lite

**Contexto.** Forzar listados/dashboards a reconstruir agregados es lento y artificial.
**Decisión.** Separar **commands** (pasan por casos de uso + dominio + repos) de
**queries** (read models que leen Prisma directo, sin dominio). Sin event sourcing.
**Consecuencias.** (+) Lecturas simples y rápidas, escrituras con invariantes. (−) Dos
caminos de acceso a datos a mantener.

---

## Seguridad (resumen)

Defensa en profundidad: ver ADR-0003 (RLS) y los puntos en `CLAUDE.md`. Items clave:
tenantId solo desde el JWT, rol DB sin BYPASSRLS + FORCE RLS, `set_config`
parametrizado dentro de transacción, jobs/WS re-establecen tenant context, refresh
rotation con reuse detection, argon2id, RBAC por membership, sanitización de email
entrante, verificación de firmas de webhooks, rate limiting en auth, logs sin secretos.
Alcance "portfolio-pragmático": lo crítico implementado, el resto documentado como future work.
