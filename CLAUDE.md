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
├─ shared-kernel/
│  ├─ domain/            # Entity, AggregateRoot, ValueObject, DomainEvent, Result, branded-id
│  └─ ports/             # Clock, IdGenerator, TransactionManager (genéricos, sin dueño)
├─ infrastructure/       # cross-cutting: config (Zod), Prisma (+ tx manager), system, tenant-context
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
- ADR-0011 **Flujo de auth** (módulo `iam`): registro self-service con provisioning, login por slug, argon2id, access JWT + refresh JWT (con `tenantId`) con rotación + reuse detection por familia.
- ADR-0012 **Resolución `slug -> tenant`** sin abrir RLS: rol dedicado `helpdesk_slug_resolver`
  (NOLOGIN, sin BYPASSRLS, GRANT a nivel de columna) + función `SECURITY DEFINER` de su propiedad.
- ADR-0013 **Rate limiting** en auth: throttler global + límites estrictos por endpoint,
  almacenamiento en memoria (revisar al escalar a varias instancias).
- ADR-0014 **Autorización por jerarquía** ADMIN > AGENT > VIEWER con `@MinRole(...)`
  (rango mínimo), no permisos granulares. El orden vive en el dominio.
- ADR-0015 **Ciclo de vida del ticket** como máquina de estados con la tabla de
  transiciones en el dominio; `CLOSED` es terminal y los timestamps se derivan.
- ADR-0016 **Unidad de trabajo explícita**: puerto `TransactionManager` +
  `AsyncLocalStorage`, para que el `AuditLog` se escriba en la MISMA transacción
  que el cambio. Es el andamio del outbox (ADR-0007).
- ADR-0017 **Numeración visible** correlativa por tenant con `ticket_counters` y un
  UPSERT que bloquea la fila dentro de la transacción del ticket.
- ADR-0018 **Eventos de integración "gordos" y versionados** escritos en
  `outbox_messages` dentro de la transacción del cambio. Los emite el AGREGADO.
- ADR-0019 **Publicador por polling** con `FOR UPDATE SKIP LOCKED` y rol dedicado
  `helpdesk_outbox_publisher`; idempotencia en dos capas (jobId + tabla
  `processed_messages` en la misma transacción que el efecto); 5 reintentos con
  backoff exponencial y **DLQ**; primer consumidor: auto-asignación round-robin.
- ADR-0020 **Modelo de SLA**: dos relojes por ticket (respuesta y resolución),
  `sla_policies` con SOLO los overrides del tenant sobre los valores por defecto
  del dominio, "respondido" = comentario de quien responde en nombre de la
  organización (de ahí `comment.added` v2 con `authorRole`), `due_at` inmutable y
  el calendario detrás de la interfaz `SlaCalendar` (hoy 24/7).
- ADR-0021 **Temporizadores durables + barrido**, no jobs retardados: `sla_timers`
  es la fuente de verdad, rol `helpdesk_sla_sweeper` + `sla_due_timers`
  (SECURITY DEFINER, devuelve solo `id` y `tenant_id`), idempotencia por condición
  —no por bloqueo—, y todo fechado con el `occurredAt` del evento.

## Seguridad (modelo, "portfolio-pragmático")

Defensa en profundidad. Puntos críticos a respetar siempre:
- El `tenantId` SIEMPRE sale del JWT autenticado, **nunca** del body/params/query.
- RLS es la última línea: rol de DB **sin BYPASSRLS y que no sea dueño de las tablas**, `FORCE ROW LEVEL SECURITY`.
- `SET LOCAL` / `set_config('app.current_tenant', $1, true)` **dentro de la misma transacción** (cuidado con connection pooling). Parametrizar el tenant, nunca concatenarlo.
- Jobs de BullMQ y WebSocket re-establecen el tenant context desde su payload (validado).
- Refresh tokens con rotación + reuse detection; passwords con argon2id; refresh en cookie httpOnly.
- RBAC: el rol es **por membership** (por tenant), no global.
- Sanitizar HTML del email entrante (anti stored-XSS). Verificar firmas de webhooks.
- Rate limiting en auth (ADR-0013): guard global + `@Throttle` estricto en login/registro/refresh.

## Metodología de trabajo (IMPORTANTE)

1. Para CADA fase: **proponer estructura/decisiones y esperar OK del usuario antes de generar código.**
2. Documentar el "por qué" como **ADRs** en `docs/ARCHITECTURE.md`.
3. Escribir los **tests junto al código**, no después.
4. Idioma: responder siempre en **español**.

## Plan de fases

1. ✅ Scaffold + docker-compose + CI mínimo
2. ✅ Auth + tenancy — **2a (Prisma + RLS), 2b (dominio + aplicación `iam`) y 2c (infraestructura + HTTP) CERRADAS**
3. ✅ RBAC (`@MinRole` + `RolesGuard` global, jerarquía en el dominio)
4. ✅ Tickets + Comentarios + AuditLog (máquina de estados, numeración por tenant)
5. ✅ Colas — 5a (outbox transaccional) y 5b (BullMQ, publicador, consumidor idempotente, DLQ)
6. ✅ SLA engine (política por tenant, relojes durables, barrido de incumplimientos)
7. 🔄 Realtime (WebSocket gateway + cliente Next)
8. ⬜ Observabilidad (Pino + OTel + health checks reales)
9. ⬜ Billing Stripe per-seat con webhooks idempotentes (opcional)
10. ⬜ Docs finales (ARCHITECTURE.md con ADRs y diagrama, README)

Dominio objetivo: Organization (tenant), User, Membership (ADMIN/AGENT/VIEWER),
Ticket, Comment, SlaPolicy, SlaTimer, AuditLog, InboundEmail.

## Estado actual (2026-09-09)

**Fase 6 (motor de SLA) — CERRADA.** Es la primera fase con configuración por
organización y la primera que reacciona al PASO DEL TIEMPO, no a una acción.

- **Dominio (`ticketing/domain/sla/`)**: `SlaTimer` (estado derivado de
  `stoppedAt`/`breachedAt`, nunca un campo `status`), `SlaPolicy` con
  `DEFAULT_SLA_POLICY` + `resolvePolicy` (merge POR PRIORIDAD), `SlaCalendar` con
  `CALENDAR_24_7`, e `isResponder` (¿este rol contesta en nombre de la
  organización?). Todo puro y testeado sin base de datos.
- **Aplicación**: `StartSlaTimers` (2 relojes al crear el ticket),
  `StopSlaTimer` (primera respuesta de un agente / resolución) y
  `MarkSlaBreached` (lo llama el barrido; audita + emite `sla.breached`).
- **`comment.added` sube a v2** con `authorRole`: sin él no se distingue la
  respuesta del agente del mensaje del propio cliente, y parar el reloj con el
  segundo dejaría cumplir el SLA a base de que el cliente insista. El rol sale
  del JWT verificado, nunca del body.
- **Infraestructura**: `SlaProcessor` (cola `sla`, `autorun: false`, DLQ propia
  con prefijo `dlq-sla-` para no pisar la de routing), `SlaSweeper`
  (`sweep(now)` público para los tests, `tick()` que nunca lanza), repos Prisma,
  migración `20260909220000_sla` con RLS + rol `helpdesk_sla_sweeper`.
- **`QueueRegistry`**: el publicador del outbox ya no conoce una cola fija; un
  mismo evento puede ir a varias (`ticket.created` → routing + sla).
- **Verificado:** lint:ci limpio, **144/144 unit**, **81/81 e2e** contra Postgres
  y Redis reales, build OK, **6 migraciones desde cero** en una BD desechable con
  `migrate diff` vacío.

**Gotchas de la fase 6:**
- El e2e usa un **reloj inyectado** (`overrideProvider(CLOCK)`): se sustituye el
  PUERTO, no la clase, así que la app entera sigue pidiendo `CLOCK` sin
  enterarse. Un SLA de 24 h se verifica en milisegundos y además se ejercita el
  CÁLCULO del vencimiento — falsear `due_at` en la BD solo probaría el barrido.
- Con una cola más (y su worker), arrancar la app en los e2e pasa de 5s: hubo que
  poner `testTimeout: 30000` en `test/jest-e2e.json`. Sin eso, `queue.e2e-spec`
  fallaba en el `beforeAll` con un mensaje que no señala la causa real.
- `ORDER BY kind` en Postgres ordena un enum por su ORDEN DE DECLARACIÓN, no
  alfabéticamente. En los tests, ordenar en JS.
- La fase 6 invalidó un test de la 5b: `ticket.status_changed` ya tiene
  consumidor, así que el caso "evento sin consumidor" pasó a usar
  `ticket.assigned`. Al añadir un consumidor, revisar qué tests asumían que ese
  evento no tenía ninguno.
- `ticket.created` se encola en DOS colas con el mismo jobId: la limpieza de jobs
  de los e2e tiene que borrarlo de las dos.

**Fase 5b (colas) — CERRADA.** El outbox ya se drena a BullMQ y hay un consumidor
real. Decisiones del usuario respetadas: polling, idempotencia con tabla + jobId,
auto-asignación round-robin.

- **Publicador (`OutboxPublisher`)**: bucle de polling (`OUTBOX_POLL_INTERVAL_MS`,
  1s por defecto) que reclama lotes con `FOR UPDATE SKIP LOCKED`, encola y marca.
  `publishPending()` es PÚBLICO para que los tests pidan un ciclo concreto en vez de
  esperar a un temporizador. `tick()` nunca lanza: una excepción mataría el bucle y
  el outbox dejaría de drenarse en silencio.
- **Rol `helpdesk_outbox_publisher`** (ADR-0019): el publicador no tiene contexto de
  tenant, y con RLS fail-closed + FORCE no vería ni una fila. Rol NOLOGIN, sin
  BYPASSRLS, GRANT por COLUMNA sobre `outbox_messages`, dueño de 3 funciones
  `SECURITY DEFINER`. Mismo patrón que el ADR-0012.
- **Idempotencia en dos capas**: `jobId` = id del mensaje (dedupe mientras Redis lo
  recuerde) + tabla `processed_messages` con PK `(consumer, event_id)` escrita en la
  MISMA transacción que el efecto. Esa es la garantía real.
- **Consumidor `TicketRoutingProcessor`** con `autorun: false`: lo arranca
  `onApplicationBootstrap` solo si `WORKER_ENABLED=1`. Separar el despliegue de
  workers del de la API será cambiar una variable de entorno.
- **`AutoAssignTicket`**: round-robin SIN estado por `(number - 1) % agentes.length`.
  Determinista, así que reprocesar da el mismo agente. Los casos definitivos
  (ticket borrado, sin agentes, ya asignado, cerrado) se devuelven como `skipped`
  OK, no como error: un `err` revertiría la marca de procesado y el job acabaría en
  la DLQ para nada. Se audita con `SYSTEM_ACTOR_ID` y `automatic: true`.
- **DLQ**: cola `dead-letter`. Los fallos permanentes (versión desconocida, evento no
  manejado) van al descarte en el PRIMER intento; los transitorios agotan 5 intentos
  con backoff exponencial.
- **Verificado:** lint:ci limpio, **114/114 unit**, **68/68 e2e** contra Postgres y
  Redis reales, build OK, 5 migraciones desde cero sin drift.

**Gotchas de 5b (varios caros):**
- `@nestjs/bullmq@12` es **solo ESM** y Jest no lo parsea: fijado a `^11`. Es
  exactamente el mismo problema que ya tuvimos con `@nestjs/jwt@12`.
- `bullmq@6` dejó **`ioredis` como dependencia opcional**: hay que instalarla a mano
  o falla en ejecución con un mensaje sobre "optional 'ioredis' package".
- Prisma envía los números de JS como **`bigint`**: `outbox_claim_batch(${n})` busca
  `(bigint, bigint)` y da 42883. Hay que castear en el SQL: `${n}::int`.
- Un **jobId de BullMQ no puede contener `:`** (los usa como separador interno).
- Capturar la violación de unicidad con `try/catch` NO sirve dentro de una
  transacción de Postgres: el statement fallido la aborta entera. Hay que usar
  `ON CONFLICT DO NOTHING` (`createMany({ skipDuplicates: true })`) y mirar el count.
- Los e2e corren con **`--runInBand`**: el publicador es global por diseño, así que en
  paralelo una suite publicaría los mensajes de otra. `global-setup` además fuerza
  `WORKER_ENABLED=0` para que nada se auto-asigne por detrás.
- `msgpackr-extract` (acelerador nativo de BullMQ) queda DENEGADO en
  `pnpm-workspace.yaml`: obligaría a tener toolchain de C++ en CI y en Docker.

**Fase 5a (outbox transaccional) — CERRADA.** Las 4 decisiones de la fase 5 se
cerraron con OK del usuario: eventos gordos versionados, publicador por polling,
idempotencia con tabla de procesados + jobId, y auto-asignación round-robin como
primer job. 5a entrega solo la escritura; el publicador va en 5b porque sin cola no
hay a dónde publicar.

- **`AggregateRoot<Id, E>`** ahora acota los eventos que un agregado puede emitir
  (por defecto `DomainEvent`, así que nada anterior cambia). `Ticket` es
  `AggregateRoot<TicketId, TicketingEvent>`: `pullDomainEvents()` sale tipado y
  emitir un evento no declarado no compila.
- **Los eventos los emite el AGREGADO**, no el caso de uso: así el ticket creado
  desde el email entrante (fase 5+) emitirá los mismos que el creado por HTTP.
- **`registerComment(...)` en `Ticket`:** comentar es actividad SOBRE el ticket, así
  que pasa por la raíz del agregado, actualiza `updatedAt` y emite `comment.added`.
  El evento se ancla al TICKET, no al comentario.
- **`EventRecorder`** (application) vuelca los eventos al outbox dentro de la
  transacción ya abierta, igual que `AuditRecorder`. Puerto `OutboxWriter` en el
  shared-kernel con SOLO `append`: leer y marcar es cosa del publicador, que tiene
  otros privilegios.
- **Migración `20260909180000_outbox`:** tabla `outbox_messages` con RLS ENABLE+FORCE
  como todo lo demás. Cadena de 4 migraciones validada DESDE CERO contra una base de
  datos desechable y `migrate diff` vacío.
- **Verificado:** lint:ci limpio, **103/103 unit**, **59/59 e2e**, build OK.

**Gotchas de 5a:**
- Postgres trunca los identificadores a **63 caracteres**: si el nombre de un índice
  en el SQL es más largo que el que Prisma espera, `migrate diff` marca drift para
  siempre. Hay que escribir en la migración el nombre YA truncado.
- Prisma **bloquea `migrate reset`** pidiendo consentimiento explícito del usuario.
  Para validar la cadena desde cero sin destruir nada: crear una BD desechable,
  `migrate deploy` contra ella, comprobar drift y borrarla.
- El índice del outbox debería ser PARCIAL (`WHERE published_at IS NULL`), pero
  Prisma no los modela y declararlo solo en SQL produciría drift permanente.
- Los dobles que siembran un ticket con `Ticket.open()` arrastran su
  `ticket.created` sin publicar. Hay que hacer `pullDomainEvents()` al sembrar, para
  que el doble no mienta respecto a producción (donde el repo REHIDRATA, sin eventos).

**Fase 4 (Tickets + AuditLog) — CERRADA.** Acá empieza el producto. Las cuatro
decisiones que estaban abiertas se cerraron con OK del usuario: máquina de estados
estricta, unidad de trabajo con `TransactionManager` + ALS, numeración por tenant
con bloqueo de fila, y alcance Ticket + AuditLog + Comment.

- **Refactor previo (importante).** `Clock` e `IdGenerator` estaban en
  `iam/domain/ports/`, pero no son conceptos de identidad: si `ticketing` los
  importaba de ahí, dos bounded contexts quedaban acoplados. Se movieron a
  `shared-kernel/ports/` (tokens `shared.*`) y sus adapters a
  `src/infrastructure/system/`, expuestos por un `SystemModule` global.
- **`TransactionManager` (ADR-0016).** Puerto en el shared-kernel; adapter Prisma
  que abre `withTenant` y publica el tx client en `AsyncLocalStorage`. Los repos
  extienden `PrismaRepository` y usan `runInTenant`, que se engancha a la
  transacción viva o abre una propia. Es **reentrante**: anidar `withTenant` pediría
  una segunda conexión del pool, rompería la atomicidad y podría hacer deadlock.
- **`runTransactional`** (`ticketing/application/transactional.ts`): convierte un
  `Result` de error en ROLLBACK. Sin él, un `err` haría COMMIT —nadie lanza— y el
  número de ticket ya reservado quedaría consumido.
- **Dominio `ticketing`:** `ticket-status.ts` con las transiciones como DATOS,
  entidad `Ticket` (sin setters; `changeStatus` es el único camino y los timestamps
  del ciclo de vida se derivan), `Comment` inmutable, `AuditLog` con acciones
  cerradas, 5 puertos (Ticket/Comment/AuditLog repos, `TicketNumberGenerator`,
  `MemberDirectory`).
- **`MemberDirectory`:** ticketing NO importa los repos de `iam`; declara el mínimo
  que necesita (¿este usuario es de este tenant?) y el acoplamiento queda en un solo
  adapter.
- **Numeración (ADR-0017):** `ticket_counters`, una fila por tenant, UPSERT con
  `ON CONFLICT DO UPDATE ... RETURNING next_number - 1` dentro de la transacción del
  ticket. Crea la fila sola, toma el bloqueo exclusivo en un único viaje a la BD.
- **HTTP:** `POST /tickets`, `GET /tickets` (paginado por CURSOR, no offset),
  `GET /tickets/:id`, `GET /tickets/:id/history`, `POST|DELETE /tickets/:id/assign`,
  `PATCH /tickets/:id/status`, `POST /tickets/:id/comments`. `JwtAuthGuard` a nivel
  de CLASE. Permisos: VIEWER lee/abre/comenta, AGENT opera la cola.
- **Lectura (CQRS-lite, ADR-0008):** `TicketReadModel` en `infrastructure/`, inyectado
  directo en el controller. En `application/` rompería la regla de dependencias.
- **Migración `20260909120000_ticketing`:** 4 tablas + 2 enums, RLS ENABLE+FORCE y
  policies fail-closed idénticas al resto, índices con prefijo `tenant_id`.
  `prisma migrate diff` contra el schema devuelve vacío (sin drift).
- **Verificado:** `lint:ci` limpio, **91/91 unit**, **53/53 e2e** contra Postgres real,
  `build` OK, migración aplicada desde cero.

**Gotchas resueltos en la fase 4:**
- Un `Result.err` devuelto desde dentro de una transacción hace **COMMIT**: para la BD
  no ha pasado nada malo. De ahí `runTransactional`.
- Cerrar un ticket NO debe borrar `resolvedAt` (la fase 6 lo necesita para el SLA);
  reabrir sí lo limpia. Los timestamps se derivan en un `switch` sobre el destino.
- Con `emitDecoratorMetadata` + `isolatedModules`, un tipo usado en una propiedad
  DECORADA debe importarse con `import type` (mismo origen que el gotcha de argon2).
- Los dobles de prueba compartidos van en `*.test-doubles.ts`, excluido en
  `tsconfig.build.json`: un `*.spec.ts` sin `it()` haría fallar a Jest.
- En supertest, un helper que deba encadenar `.expect(...)` **no** puede ser `async`.

**Fase 3 (RBAC) — CERRADA.**
- `domain/role.ts`: `ROLE_RANK` + `hasAtLeastRole()`. El orden de autoridad es una
  regla de negocio, así que vive en el dominio y se testea sin HTTP (6 unit tests).
- `@MinRole(role)` declara el rango **mínimo**; se llama así y no `@Roles` porque con
  jerarquía `@Roles('AGENT')` se leería como "solo AGENT".
- `RolesGuard` registrado como segundo `APP_GUARD` (después del throttler: no tiene
  sentido comprobar el rol de una petición que ya excedió su cuota). No exige nada si
  la ruta no declara `@MinRole`, y distingue 401 (sin sesión) de 403 (sin rango).
- ADR-0014 con la decisión, sus tres alternativas descartadas y su disparador de revisión.
- e2e `rbac.e2e-spec.ts` con un controller definido SOLO en el test: la fase 3 entrega
  el mecanismo, no rutas de producto. Cubre la jerarquía completa, 401 vs 403, el caso
  de `@MinRole` sin `JwtAuthGuard`, y el desfase del rol en el token ya emitido.
- **Verificado:** `lint:ci` limpio, 43/43 unit, **29/29 e2e**, `build` OK.


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
- **Rate limiting (ADR-0013):** `@nestjs/throttler` como guard global + límites
  estrictos por endpoint. Suite propia `auth-rate-limit.e2e-spec.ts` con el guard real.
- **Precondición de e2e:** `test/global-setup.ts` comprueba conexión y migraciones, y
  si faltan dice exactamente qué comando ejecutar en vez de fallar con un error de Prisma.
- **Verificado:** `lint:ci` limpio, **37/37 unit**, **20/20 e2e** contra Postgres real,
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

## PENDIENTE (retomar acá → Fase 7)

Fases 1, 2 (a/b/c), 3, 4, 5 (a/b) y 6 cerradas. El backend ya hace lo suyo solo:
un ticket nuevo se auto-asigna, arranca sus relojes de SLA, y si nadie lo atiende
el barrido registra el incumplimiento sin que nadie pregunte.

**Cabos sueltos de la fase 6 (decidir si entran o se dejan documentados):**
- No hay endpoint para configurar `sla_policies`: la tabla existe y el motor la
  respeta, pero hoy solo se escribe por SQL. Un `GET/PUT /sla-policies` (ADMIN)
  sería media hora y cierra la historia de "configuración por organización".
- La vista del ticket no expone su SLA (`dueAt`, cuánto margen queda, si
  incumplió). Es lo que haría útil el motor de cara al front de la fase 7.
- Nadie consume `sla.breached` todavía: el evento se publica y se queda ahí. Su
  consumidor natural es la notificación/escalado.

**Fase 7 — Realtime.** WebSocket gateway (Socket.io) + cliente en `helpdesk-web`.
Es la primera fase que empuja datos hacia el cliente en vez de responder a
peticiones, y la primera en la que el aislamiento por tenant tiene que
sostenerse FUERA del ciclo request/response.

Decisiones abiertas, **pendientes de OK del usuario**:

1. **Cómo se autentica el socket.** ¿Access token en el handshake (`auth.token`),
   cookie, o un ticket de conexión de un solo uso emitido por HTTP? El JWT en el
   handshake es lo directo; el problema conocido es qué pasa cuando expira con la
   conexión abierta.
2. **Quién emite.** ¿Un consumidor más del outbox (cola `realtime`, coherente con
   todo lo hecho: lo que se emite es exactamente lo que ocurrió y se puede
   reprocesar) o emitir desde los casos de uso (menos piezas, pero vuelve a meter
   un efecto no transaccional dentro del caso de uso — justo lo que el ADR-0018
   existe para evitar)?
3. **Qué se manda por el cable.** ¿El evento de integración tal cual (gordo, y
   puede llevar campos que ese usuario no debería ver) o un DTO de vista filtrado
   por rol? Lo segundo obliga a decidir qué ve un VIEWER.
4. **Granularidad de las rooms.** ¿Solo `tenant:<id>`, o también `ticket:<id>` y
   `user:<id>` para avisar al asignado? Más rooms = menos ruido en el cliente,
   más contabilidad en el servidor.
5. **Escalado.** ¿Adapter de Redis para Socket.io desde ya (varias instancias
   comparten las rooms) o un solo proceso y se documenta como deuda?

Checklist tentativo:
- [ ] Gateway con guard de handshake que reusa `JwtTokenService` y mete al socket
      en la room de SU tenant (el `tenantId` sale del token, nunca del cliente).
- [ ] Consumidor `realtime` que traduce eventos de integración a mensajes de vista.
- [ ] e2e con cliente Socket.io real: dos tenants conectados, uno crea un ticket,
      el otro NO lo recibe. El equivalente WebSocket de `rls-isolation`.
- [ ] Cliente en `helpdesk-web`: el `ws-provider` placeholder de la fase 1 pasa a
      ser real, con invalidación de las queries de TanStack Query.
- [ ] ADR-0022 (transporte y autenticación) y ADR-0023 (qué se emite y a quién).

Recordar: proponer estructura/decisiones y **esperar OK** antes de codear.

## Al retomar (última sesión: 2026-09-09)

Árbol limpio. Los e2e limpian sus organizaciones y sus jobs al terminar.

```bash
docker compose -f infra/docker-compose.yml up -d   # Postgres 17 + Redis 7
pnpm prisma:deploy                                  # 6 migraciones
pnpm test && pnpm test:e2e                          # 144 unit + 81 e2e en verde
```

Para ver el sistema entero funcionando (workers incluidos): `pnpm start:dev`, crear
un ticket con `POST /tickets` y observar cómo se auto-asigna en menos de dos segundos
y estrena sus dos relojes de SLA en `sla_timers`. Para ver un incumplimiento sin
esperar cuatro horas: bajar `response_minutes` en `sla_policies` (o `UPDATE
sla_timers SET due_at = now()`) y esperar un ciclo del barrido.

**Recordatorio de entorno:** `pnpm` no está en el PATH — usar `corepack pnpm`.
Docker Desktop hay que arrancarlo a mano. Git en este repo (sobre OneDrive) es lento:
usar timeouts largos. `prisma migrate reset` está BLOQUEADO para agentes sin
consentimiento explícito: para validar migraciones desde cero, crear una base de
datos desechable, hacer `migrate deploy` contra ella y borrarla.

## Comandos

```bash
pnpm install        # respeta allowBuilds de pnpm-workspace.yaml
pnpm start:dev      # arranca en watch (http://localhost:3000, docs en /docs)
pnpm build
pnpm test           # unit
pnpm test:e2e       # e2e
pnpm lint
```
