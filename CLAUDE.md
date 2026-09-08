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
- ADR-0012 **Resolución `slug -> tenant`** sin abrir RLS: rol dedicado `helpdesk_slug_resolver`
  (NOLOGIN, sin BYPASSRLS, GRANT a nivel de columna) + función `SECURITY DEFINER` de su propiedad.
- ADR-0011 **Flujo de auth** (módulo `iam`): registro self-service con provisioning, login por slug, argon2id, access JWT + refresh JWT (con `tenantId`) con rotación + reuse detection por familia.

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
2. ✅ Auth + tenancy — **2a (Prisma + RLS), 2b (dominio + aplicación `iam`) y 2c (infraestructura + HTTP) CERRADAS**
3. 🔄 RBAC (guard + decorator `@Roles`)
4. ⬜ Tickets CRUD + AuditLog
5. ⬜ Colas (routing job, DLQ, backoff)
6. ⬜ SLA engine (delayed jobs, breach, escalado)
7. ⬜ Realtime (WebSocket gateway + cliente Next)
8. ⬜ Observabilidad (Pino + OTel + health checks reales)
9. ⬜ Billing Stripe per-seat con webhooks idempotentes (opcional)
10. ⬜ Docs finales (ARCHITECTURE.md con ADRs y diagrama, README)

Dominio objetivo: Organization (tenant), User, Membership (ADMIN/AGENT/VIEWER),
Ticket, Comment, SlaPolicy, SlaTimer, AuditLog, InboundEmail.

## Estado actual (2026-09-08)

**Fase 2c (infraestructura `iam` + HTTP) — CERRADA.** La API ya se puede usar de
punta a punta. Hecho y verificado:
- **Adapters:** `Argon2PasswordHasher` (argon2id vía `@node-rs/argon2`, params OWASP),
  `JwtTokenService` (access + refresh firmados con secretos distintos; hash SHA-256
  del refresh para el lookup), `SystemClock`, `UuidGenerator`, y los 4 repos Prisma
  corriendo cada operación dentro de `withTenant`.
- **HTTP:** `POST /auth/{register,login,refresh,logout}` + `GET /auth/me`, con DTOs
  validados, Swagger, refresh en cookie httpOnly (`Path=/auth`) y mapeo de
  `IamError.code` a `application/problem+json` (RFC 7807).
- **Contexto de tenant:** `TenantContextMiddleware` (AsyncLocalStorage) + `JwtAuthGuard`
  + decorador `@CurrentUser`. Es middleware y no interceptor a propósito: un
  interceptor devuelve un Observable que Nest suscribe fuera del scope de
  `AsyncLocalStorage` y el contexto se perdería.
- **`IamModule`:** casos de uso construidos con `useFactory` inyectando por TOKEN de
  puerto, de modo que siguen siendo clases puras sin decoradores de Nest.
- **`src/bootstrap.ts`:** configuración del pipeline compartida por `main.ts` y los
  e2e, para que los tests ejerciten exactamente el mismo pipeline que producción.
- **ADR-0012** escrito (la migración de julio ya lo referenciaba pero no existía).
- **Verificado:** `lint:ci` limpio, **37/37 unit**, **17/17 e2e** contra Postgres real,
  `build` OK, ambas migraciones aplicadas desde cero, y flujo probado a mano con curl
  (registro → me → login → rotación → reuse detection → revocación de familia).

**Gotchas resueltos en 2c (para no volver a tropezar):**
- `@nestjs/jwt@12` es **solo ESM** y Jest (CommonJS) no lo puede parsear: se fija a
  `^11`, que es la línea que acompaña a Nest 11.
- `Algorithm` de `@node-rs/argon2` es un `const enum` ambiente: con `isolatedModules`
  no se puede leer su valor; se usa la constante `2` (Argon2id) con import de tipo.
- Nest 11 va sobre Express 5, donde `forRoutes('*')` ya no es válido: el middleware
  de tenant se registra como middleware global en `configureApp`.

## Estado anterior (2026-06-25)

**Fase 2b (dominio + aplicación `iam`) — CERRADA.** Commiteada en `6e41da2`:
- `src/modules/iam/domain`: branded ids; `Role`; errores-as-values (`DomainError` en shared-kernel + errores IAM con `code`); VOs `Email`/`Password`/`PasswordHash`; entidades `Organization`/`User`/`Membership`/`RefreshToken` (estado de refresh: `isActive`/`isSpent`/`isExpired`); `slugify`; 8 **puertos** (repos User/Organization/Membership/RefreshToken, `PasswordHasher`, `TokenService`, `IdGenerator`, `Clock`).
- `src/modules/iam/application`: `SessionIssuer` (emite access+refresh, familia nueva vs existente) y 4 casos de uso — `RegisterOrganization` (provisioning), `Login` (por slug, anti-enumeración), `RefreshTokens` (rotación + reuse → revoca familia), `Logout` (idempotente). Devuelven `Result`.
- Dominio y aplicación **puros** (sin Nest ni Prisma). Tests unit con puertos mockeados.
- ADR-0011 en ARCHITECTURE.md. Override de ESLint para tests (relaja reglas type-aware ruidosas con mocks de Jest, solo en `*.spec.ts`/`test/**`).
- **Verificado:** `lint:ci` + **37/37 unit** + `build` OK. (Los e2e de 2a siguen verdes; `iam` aún no se expone por HTTP — eso es 2c.)
- **Decisiones tomadas:** módulo `iam` (no `auth`); login requiere `organizationSlug`; refresh es JWT firmado con `tenantId`; resolución slug→tenant irá por función `SECURITY DEFINER` en 2c.

**Fase 2a (Prisma + RLS) — CERRADA.** Hecho y verificado en `helpdesk-api`:
- `prisma/schema.prisma`: `Organization`, `User`, `Membership` + enum `Role`. Datasource con
  `url` (rol app restringido) + `directUrl` (rol owner solo para migraciones).
- `src/infrastructure/prisma`: `PrismaService` (lifecycle + `withTenant(tenantId, fn)`) y `PrismaModule` global, wired en `app.module`.
- Migración `init_auth_tenancy`: DDL + **rol `helpdesk_app`** (LOGIN, sin BYPASSRLS, no-owner, idempotente) + GRANTs DML + `ALTER DEFAULT PRIVILEGES` + `ENABLE/FORCE RLS` + policies `tenant_isolation` fail-closed (`NULLIF(current_setting('app.current_tenant', true), '')::uuid`).
- `env.schema`: `DATABASE_URL` ahora **required**; nuevo `MIGRATION_DATABASE_URL` (opcional, solo migraciones). `.env`/`.env.example` actualizados.
- CI: servicio Postgres 17 + `prisma generate` + `prisma migrate deploy` antes de los tests.
- Test estrella `test/rls-isolation.e2e-spec.ts`: aislamiento cross-tenant (cada tenant ve solo lo suyo, no lee por id ajeno, fail-closed sin contexto, WITH CHECK bloquea insertar en otro tenant).
- `pnpm-workspace.yaml`: builds de `prisma`/`@prisma/*` aprobados.
- **Verificado:** `lint:ci`, 7/7 unit, 5/5 e2e, `build` OK. App levanta (`/health` 200, `/docs` 200, Prisma conecta como `helpdesk_app`). Migración valida desde cero. Commiteada en `da83958`.

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

## PENDIENTE (retomar acá → Fase 3)

Fases 1, 2a, 2b y 2c cerradas. La API de autenticación funciona end-to-end.

**Fase 3 — RBAC:**
- [ ] Decorador `@Roles(...)` + `RolesGuard` que lee el rol del contexto de tenant
      (nunca del body/query), con jerarquía ADMIN > AGENT > VIEWER.
- [ ] Aplicarlo a una ruta de prueba y cubrirlo con e2e (403 vs 200 por rol).
- [ ] ADR-0013 con la decisión de jerarquía de roles vs permisos granulares.

**Fase 4 — Tickets + AuditLog** (el producto empieza acá):
- [ ] Modelo `Ticket`, `Comment`, `AuditLog` con RLS igual que el resto.
- [ ] CRUD de tickets + comentarios, con `withTenant` en cada operación.
- [ ] Índices pensados para multi-tenant (prefijo `tenant_id`, como en refresh_tokens).

Recordar: proponer estructura/decisiones y **esperar OK** antes de codear.

## Comandos

```bash
pnpm install        # respeta allowBuilds de pnpm-workspace.yaml
pnpm start:dev      # arranca en watch (http://localhost:3000, docs en /docs)
pnpm build
pnpm test           # unit
pnpm test:e2e       # e2e
pnpm lint
```
