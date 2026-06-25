# Helpdesk API — Claude Code context

> Este archivo se carga automáticamente en cada sesión de Claude Code dentro de
> este repo. Es la fuente de verdad del contexto del proyecto y del plan de trabajo.

## Qué es

SaaS de **helpdesk multi-tenant y event-driven**. Proyecto de **portfolio fullstack
senior con foco backend**. Objetivo explícito: **mostrar decisiones de arquitectura**,
no cantidad de features.

Dos repos separados (NO monorepo — decisión deliberada, ver ADR-0001):
- `helpdesk-api` (este) — NestJS, arquitectura hexagonal.
- `helpdesk-web` — Next.js App Router. **Ya scaffoldeado** (Fase 1 cerrada): repo PÚBLICO
  https://github.com/MarcosEstebanDev/helpdesk-web (ojo: el web es público, este api es privado).

## Stack y tooling

- **Backend:** NestJS 11 + TypeScript 5.7 (modo strict).
- **DB:** PostgreSQL 17 con **Row-Level Security** (aislamiento por `tenant_id`, NO schema-per-tenant).
- **ORM:** Prisma 6 (con `SET LOCAL app.current_tenant` por transacción para que RLS funcione).
- **Colas:** BullMQ 5 + Redis 7 (DLQ, backoff exponencial, idempotencia).
- **Realtime:** Socket.io (rooms por tenant).
- **Auth:** JWT access + refresh (access lleva `userId`, `tenantId`, `role`).
- **Observabilidad:** Pino (estructurado, con `tenantId`/`requestId`), OpenTelemetry, health checks.
- **Testing:** Jest (unit + integración con Testcontainers + e2e con supertest).
- **Tooling:** Node 24, pnpm 11. `pnpm-workspace.yaml` define `allowBuilds` (política de build scripts de pnpm 11).

## Arquitectura (hexagonal / ports & adapters)

Regla de dependencias: **`infrastructure -> application -> domain`**. El dominio no
importa Prisma, ni Nest, ni nada externo.

```
src/
├─ modules/<bounded-context>/
│  ├─ domain/            # entidades, value objects, eventos de dominio, PORTS (interfaces)
│  ├─ application/       # casos de uso (commands/queries) — depende solo de domain
│  └─ infrastructure/    # ADAPTERS: repos Prisma, controllers HTTP, mappers
├─ shared-kernel/        # Entity, AggregateRoot, ValueObject, DomainEvent, Result, branded-id
├─ infrastructure/       # cross-cutting: config (Zod), y luego Prisma, logger, tenant-context
└─ main.ts               # bootstrap + ValidationPipe + Swagger (OpenAPI)
```

**Wiring de puertos en Nest:** inyección por token de interfaz
(`{ provide: TICKET_REPOSITORY, useClass: PrismaTicketRepository }`); los casos de
uso dependen de la interfaz, nunca del adapter.

## Decisiones locked (ver `docs/ARCHITECTURE.md` para el detalle/ADRs)

- ADR-0001 Repos separados (no monorepo).
- ADR-0002 Hexagonal con regla de dependencias de Clean.
- ADR-0003 Multi-tenancy con Postgres RLS row-level.
- ADR-0004 Contratos vía **OpenAPI** (el front genera cliente tipado desde el spec).
- ADR-0005 Errores como valores (`Result`) en domain/application; excepciones solo en los bordes.
- ADR-0006 **Branded types** para IDs (`TenantId`, `TicketId`…) — seguridad por diseño.
- ADR-0007 **Transactional outbox** para publicar eventos de forma confiable.
- ADR-0008 **CQRS-lite** (commands por casos de uso; queries con read models que leen Prisma directo).
- ADR-0009 **Tenant context** vía transacción + `set_config('app.current_tenant', $1, true)` (`PrismaService.withTenant`).
- ADR-0010 **RLS multicapa**: rol de app `helpdesk_app` sin BYPASSRLS + `FORCE RLS` + policies fail-closed con `NULLIF(current_setting(...), '')`.

## Seguridad (modelo, "portfolio-pragmático")

Defensa en profundidad. Puntos críticos a respetar siempre:
- El `tenantId` SIEMPRE sale del JWT autenticado, **nunca** del body/params/query.
- RLS es la última línea: rol de DB **sin BYPASSRLS y que no sea dueño de las tablas**, `FORCE ROW LEVEL SECURITY`.
- `SET LOCAL` / `set_config('app.current_tenant', $1, true)` **dentro de la misma transacción** (cuidado con connection pooling). Parametrizar el tenant, nunca concatenarlo.
- Jobs de BullMQ y WebSocket re-establecen el tenant context desde su payload (validado).
- Refresh tokens con rotación + reuse detection; passwords con argon2id; refresh en cookie httpOnly.
- RBAC: el rol es **por membership** (por tenant), no global.
- Sanitizar HTML del email entrante (anti stored-XSS). Verificar firmas de webhooks.

## Metodología de trabajo (IMPORTANTE)

1. Para CADA fase: **proponer estructura/decisiones y esperar OK del usuario antes de generar código.**
2. Documentar el "por qué" como **ADRs** en `docs/ARCHITECTURE.md`.
3. Escribir los **tests junto al código**, no después.
4. Idioma: responder siempre en **español**.

## Plan de fases

1. ✅ Scaffold + docker-compose + CI mínimo
2. 🔄 Auth + tenancy — **2a (Prisma + RLS) CERRADA**; falta 2b (auth domain/application) y 2c (JWT, controllers, interceptor de tenant context)
3. ⬜ RBAC (guard + decorator `@Roles`)
4. ⬜ Tickets CRUD + AuditLog
5. ⬜ Colas (routing job, DLQ, backoff)
6. ⬜ SLA engine (delayed jobs, breach, escalado)
7. ⬜ Realtime (WebSocket gateway + cliente Next)
8. ⬜ Observabilidad (Pino + OTel + health checks reales)
9. ⬜ Billing Stripe per-seat con webhooks idempotentes (opcional)
10. ⬜ Docs finales (ARCHITECTURE.md con ADRs y diagrama, README)

Dominio objetivo: Organization (tenant), User, Membership (ADMIN/AGENT/VIEWER),
Ticket, Comment, SlaPolicy, SlaTimer, AuditLog, InboundEmail.

## Estado actual (2026-06-25)

**Fase 2a (Prisma + RLS) — CERRADA.** Hecho y verificado en `helpdesk-api`:
- `prisma/schema.prisma`: `Organization`, `User`, `Membership` + enum `Role`. Datasource con
  `url` (rol app restringido) + `directUrl` (rol owner solo para migraciones).
- `src/infrastructure/prisma`: `PrismaService` (lifecycle + `withTenant(tenantId, fn)`) y `PrismaModule` global, wired en `app.module`.
- Migración `init_auth_tenancy`: DDL + **rol `helpdesk_app`** (LOGIN, sin BYPASSRLS, no-owner, idempotente) + GRANTs DML + `ALTER DEFAULT PRIVILEGES` + `ENABLE/FORCE RLS` + policies `tenant_isolation` fail-closed (`NULLIF(current_setting('app.current_tenant', true), '')::uuid`).
- `env.schema`: `DATABASE_URL` ahora **required**; nuevo `MIGRATION_DATABASE_URL` (opcional, solo migraciones). `.env`/`.env.example` actualizados.
- CI: servicio Postgres 17 + `prisma generate` + `prisma migrate deploy` antes de los tests.
- Test estrella `test/rls-isolation.e2e-spec.ts`: aislamiento cross-tenant (cada tenant ve solo lo suyo, no lee por id ajeno, fail-closed sin contexto, WITH CHECK bloquea insertar en otro tenant).
- `pnpm-workspace.yaml`: builds de `prisma`/`@prisma/*` aprobados.
- **Verificado:** `lint:ci`, 7/7 unit, 5/5 e2e, `build` OK. App levanta (`/health` 200, `/docs` 200, Prisma conecta como `helpdesk_app`). Migración valida desde cero con `ON_ERROR_STOP=1`. **No commiteado/pusheado aún.**

**Aprendizaje RLS (importante):** un GUC con namespace propio, tras setearse una vez en la
sesión, al resetearse vuelve a **cadena vacía** `''` (no NULL); `''::uuid` lanza `22P02`. Por eso
las policies usan `NULLIF(current_setting(...), '')` para colapsar "sin setear" y "reseteado" a NULL.

**Fase 1 (backend) — CERRADA.** Hecho y verificado en `helpdesk-api`:
- Estructura hexagonal + `shared-kernel` (Result, Entity, AggregateRoot, ValueObject, DomainEvent, branded-id).
- Config tipada con Zod (`src/infrastructure/config`).
- Módulo `health` (`GET /health`) como ejemplo de bounded context.
- Swagger/OpenAPI montado en `/docs`. `ValidationPipe` global.
- `infra/docker-compose.yml` (Postgres 17 + Redis 7 con healthchecks).
- `Dockerfile` multi-stage (pnpm via corepack, runner no-root) + `.dockerignore`.
- CI GitHub Actions (`.github/workflows/ci.yml`): install → `lint:ci` → test → test:e2e → build. (`lint:ci` = eslint sin `--fix`, `--max-warnings 0`).
- `.gitignore` + `.gitattributes` (normaliza EOL a LF) + **git init + commit inicial** (`24d8cb3`, rama `main`, 36 archivos).
- **Remote en GitHub:** `origin` → https://github.com/MarcosEstebanDev/helpdesk-api (privado). `main` trackea `origin/main`.
- **Verificado:** `pnpm lint:ci`, `pnpm build`, 7/7 unit, 1/1 e2e en verde.

## PENDIENTE (retomar acá → Fase 2b)

Fase 1 cerrada en ambos repos. Fase 2a (Prisma + RLS) cerrada. Siguiente:

**Fase 2b — módulo `auth` hexagonal (domain + application):**
- [ ] Entidades/VOs: `Email`, `PasswordHash`; branded IDs `TenantId`/`UserId`.
- [ ] Ports: `UserRepository`, `PasswordHasher`, `TokenService`.
- [ ] Casos de uso: `RegisterOrganization` (crea Org+User+Membership ADMIN en una tx), `Login`, `RefreshTokens`, `Logout`. Tests unit con puertos mockeados.

**Fase 2c — infraestructura auth:**
- [ ] Repos Prisma (usando `withTenant`), `Argon2Hasher`, `JwtTokenService` (access+refresh, rotación+reuse detection, refresh en cookie httpOnly), modelo `RefreshToken` (nueva migración).
- [ ] Controllers `POST /auth/{register,login,refresh,logout}`, `JwtAuthGuard` + `TenantContextInterceptor` (puebla el tenant para `withTenant` desde el JWT).
- [ ] e2e: happy path + refresh rotation/reuse.

Recordar: proponer estructura/decisiones y **esperar OK** antes de codear (ADR-0011 = flujo de auth).

## Comandos

```bash
pnpm install        # respeta allowBuilds de pnpm-workspace.yaml
pnpm start:dev      # arranca en watch (http://localhost:3000, docs en /docs)
pnpm build
pnpm test           # unit
pnpm test:e2e       # e2e
pnpm lint
```
