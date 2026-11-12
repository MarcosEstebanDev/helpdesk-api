# Architecture

Helpdesk SaaS — multi-tenant, event-driven. Este documento registra las
decisiones de arquitectura como **ADRs** (Architecture Decision Records). Cada
ADR explica el contexto, la decisión y las consecuencias.

> Estado de los ADRs: `Accepted` salvo indicación. Algunos describen patrones que
> se implementan en fases posteriores (se anota la fase).

---

## Índice de ADRs

29 decisiones. Cada una registra el contexto, la alternativa descartada y
lo que costaría revertirla.

**Fundaciones** — Cómo está partido el código y qué reglas obedece.

- [ADR-0001](#adr-0001--repos-separados-no-monorepo) — Repos separados (no monorepo)
- [ADR-0002](#adr-0002--arquitectura-hexagonal-ports--adapters-con-regla-de-dependencias-de-clean) — Arquitectura hexagonal (ports & adapters) con regla de dependencias de Clean
- [ADR-0005](#adr-0005--errores-como-valores-result-en-domainapplication) — Errores como valores (`Result`) en domain/application
- [ADR-0006](#adr-0006--branded-types-para-ids) — Branded types para IDs
- [ADR-0008](#adr-0008--cqrs-lite) — CQRS-lite

**Multi-tenancy y seguridad** — El aislamiento entre organizaciones y quién puede hacer qué.

- [ADR-0003](#adr-0003--multi-tenancy-con-postgresql-row-level-security-row-level) — Multi-tenancy con PostgreSQL Row-Level Security (row-level)
- [ADR-0009](#adr-0009--tenant-context-vía-transacción--set_config) — Tenant context vía transacción + `set_config`
- [ADR-0010](#adr-0010--rls-multicapa-rol-de-app-restringido--force-rls) — RLS multicapa: rol de app restringido + FORCE RLS
- [ADR-0011](#adr-0011--flujo-de-autenticación-módulo-iam) — Flujo de autenticación (módulo `iam`)
- [ADR-0012](#adr-0012--resolución-slug---tenant-sin-abrir-rls-rol-dedicado--security-definer) — Resolución `slug -> tenant` sin abrir RLS (rol dedicado + `SECURITY DEFINER`)
- [ADR-0013](#adr-0013--rate-limiting-en-autenticación) — Rate limiting en autenticación
- [ADR-0014](#adr-0014--autorización-por-jerarquía-de-roles-no-permisos-granulares) — Autorización por jerarquía de roles (no permisos granulares)

**Ticketing** — El dominio: ciclo de vida, atomicidad y numeración.

- [ADR-0015](#adr-0015--ciclo-de-vida-del-ticket-como-máquina-de-estados-en-el-dominio) — Ciclo de vida del ticket como máquina de estados en el dominio
- [ADR-0016](#adr-0016--unidad-de-trabajo-explícita-el-auditlog-en-la-misma-transacción) — Unidad de trabajo explícita: el AuditLog en la misma transacción
- [ADR-0017](#adr-0017--numeración-visible-correlativa-por-tenant) — Numeración visible correlativa por tenant
- [ADR-0028](#adr-0028--notas-internas-visibilidad-del-comentario-sla-y-sala-del-equipo) — Notas internas: visibilidad del comentario, SLA y sala del equipo
- [ADR-0029](#adr-0029--pausa-del-sla-reloj-pausable-vencimiento-corrido-y-pausa-en-la-transacción-del-cambio) — Pausa del SLA: reloj pausable, vencimiento corrido y pausa en la transacción del cambio
- [ADR-0030](#adr-0030--respuestas-predefinidas-solo-texto-variables-cerradas-y-relleno-en-el-cliente) — Respuestas predefinidas: solo texto, variables cerradas y relleno en el cliente
- [ADR-0031](#adr-0031--etiquetas-catálogo-por-organización-clasificación-interna-y-fuera-del-agregado) — Etiquetas: catálogo por organización, clasificación interna y fuera del agregado

**Trabajo asíncrono** — Cómo un cambio se convierte en efectos, sin perder eventos.

- [ADR-0007](#adr-0007--transactional-outbox-para-publicar-eventos) — Transactional outbox para publicar eventos
- [ADR-0018](#adr-0018--eventos-de-integración-gordos-en-un-outbox-transaccional) — Eventos de integración "gordos" en un outbox transaccional
- [ADR-0019](#adr-0019--publicador-por-polling-idempotencia-en-base-de-datos-y-dlq) — Publicador por polling, idempotencia en base de datos y DLQ
- [ADR-0020](#adr-0020--modelo-de-sla-dos-relojes-política-por-tenant-y-calendario-enchufable) — Modelo de SLA: dos relojes, política por tenant y calendario enchufable
- [ADR-0021](#adr-0021--temporizadores-durables-en-base-de-datos-y-barrido-no-jobs-retardados) — Temporizadores durables en base de datos y barrido, no jobs retardados

**Tiempo real** — Cómo llega un cambio a una pantalla abierta.

- [ADR-0022](#adr-0022--transporte-de-tiempo-real-handshake-con-jwt-rooms-por-tenant-y-adapter-de-redis) — Transporte de tiempo real: handshake con JWT, rooms por tenant y adapter de Redis
- [ADR-0023](#adr-0023--qué-se-emite-y-a-quién-un-dto-de-vista-no-el-evento-de-integración) — Qué se emite y a quién: un DTO de vista, no el evento de integración
- [ADR-0025](#adr-0025--directorio-de-miembros-y-composición-del-principal) — Directorio de miembros y composición del principal

**Contrato y operación** — La frontera con el frontend y cómo se mira el sistema por dentro.

- [ADR-0004](#adr-0004--contratos-vía-openapi) — Contratos vía OpenAPI
- [ADR-0024](#adr-0024--observabilidad-logs-estructurados-correlación-hasta-el-worker-y-sondas-separadas) — Observabilidad: logs estructurados, correlación hasta el worker y sondas separadas
- [ADR-0026](#adr-0026--despliegue-gestionado-rol-dueño-propio-prisma-en-la-imagen-y-rotación-de-credenciales) — Despliegue gestionado: rol dueño propio, Prisma en la imagen y rotación de credenciales (adenda: Postgres sin superusuario y despliegue gratis)

**IA** — Dónde entra un modelo de lenguaje y qué puede tocar.

- [ADR-0027](#adr-0027--triage-con-ia-servicio-externo-sin-estado-y-la-ia-sugiere-no-decide) — Triage con IA: servicio externo sin estado, y la IA sugiere, no decide

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

## ADR-0009 — Tenant context vía transacción + `set_config`

**Contexto.** Para que las policies de RLS (ADR-0003) filtren por tenant, Postgres
necesita saber el tenant actual. Con un pool de conexiones no se puede usar una
variable de sesión global: la conexión se reusa entre requests y el contexto se
filtraría de un tenant a otro.
**Decisión (fase 2).** `PrismaService.withTenant(tenantId, fn)` abre una transacción
y ejecuta `SELECT set_config('app.current_tenant', $1, true)` (con `is_local = true`)
**al inicio** de esa transacción. El valor solo vive dentro de la transacción, así que
ninguna otra request hereda el contexto aunque comparta conexión. El `tenantId` se
pasa **parametrizado** (bind param), nunca concatenado, y proviene siempre del JWT.
**Consecuencias.** (+) Aislamiento correcto bajo pooling; imposible "olvidarse" de
filtrar (lo hace la DB). (−) Toda operación tenant-scoped debe correr dentro de
`withTenant` (una transacción por unidad de trabajo).

## ADR-0010 — RLS multicapa: rol de app restringido + FORCE RLS

**Contexto.** RLS protege solo si la app no puede saltearla. Por defecto el dueño de
las tablas y los superusuarios ignoran las policies.
**Decisión (fase 2).** Dos conexiones: las **migraciones** corren con un rol
owner/superusuario (`MIGRATION_DATABASE_URL`); la **aplicación** corre con un rol
restringido `helpdesk_app` (`DATABASE_URL`) **sin BYPASSRLS y que no es dueño de las
tablas**, con solo `SELECT/INSERT/UPDATE/DELETE`. Además se activa `FORCE ROW LEVEL
SECURITY` en cada tabla tenant-scoped. Las policies son **fail-closed**: usan
`current_setting('app.current_tenant', true)` (missing_ok), de modo que sin contexto
de tenant el valor es NULL y no devuelve ninguna fila. La tabla `organizations` se
aísla por `id`; las hijas (`users`, `memberships`, …) por `tenant_id`.
**Consecuencias.** (+) Última línea de defensa real: aunque un caso de uso tenga un
bug y omita el filtro, la DB no deja ver datos de otro tenant. (+) Verificable con un
e2e de aislamiento cross-tenant. (−) El rol de app y las policies viven en SQL crudo
dentro de la migración (Prisma no los modela); el rol/credencial local va en la
migración por pragmatismo de portfolio (en prod se provisiona por IaC).

## ADR-0011 — Flujo de autenticación (módulo `iam`)

**Contexto.** Hace falta auth multi-tenant sin filtrar información entre tenants ni
permitir enumeración de cuentas, y con sesiones revocables. El bounded context se
llama **`iam`** (Identity & Access Management): agrupa identidad (Organization, User,
Membership), credenciales y sesiones, y en Fase 3 sumará RBAC.
**Decisión (fase 2b — dominio + aplicación).**
- **Registro self-service:** `RegisterOrganization` crea Organization + User +
  Membership(ADMIN) y deja la sesión iniciada. El *provisioning* resuelve el
  huevo-o-la-gallina de RLS: se genera el `orgId` en la app y se inserta todo dentro
  de `withTenant(orgId)` (el `WITH CHECK` pasa porque el contexto = tenant nuevo).
- **Login por slug:** el `organizationSlug` resuelve el tenant ANTES de buscar al
  usuario (email único por tenant). La resolución slug→id es el único acceso que NO
  depende del contexto de tenant ⇒ se implementará (2c) con una función Postgres
  `SECURITY DEFINER`, no abriendo RLS.
- **Passwords:** política mínima en el VO `Password`; hash **argon2id** vía el puerto
  `PasswordHasher`. Nunca se persiste el texto plano.
- **Tokens:** access JWT corto (claims `userId`/`tenantId`/`role`) + **refresh JWT
  firmado que carga `tenantId`** (así `/auth/refresh` conoce el tenant sin lookup
  previo). Del refresh solo se persiste su **hash**.
- **Rotación + reuse detection:** cada refresh válido se marca rotado y se emite uno
  nuevo en la misma **familia**; presentar un refresh ya rotado/revocado revoca la
  familia entera (robo). `Logout` revoca la familia (idempotente).
- **Anti-enumeración:** todos los fallos de login devuelven el mismo error genérico.
- **Pureza:** dominio y aplicación no importan Nest ni Prisma; dependen de 8 puertos
  (repos de User/Organization/Membership/RefreshToken, `PasswordHasher`,
  `TokenService`, `IdGenerator`, `Clock`). Los casos de uso devuelven `Result`.
**Consecuencias.** (+) Lógica de auth 100% testeable por unidad con puertos mockeados
(reuse detection incluido), sin DB ni HTTP. (+) Sesiones revocables y robo detectable.
(−) Login requiere el slug de la org (UX de "workspace"). (−) Más puertos que mockear;
la implementación real (argon2, JWT, repos Prisma, función `SECURITY DEFINER`,
controllers, cookies, interceptor de tenant) queda para 2c.


## ADR-0012 — Resolución `slug -> tenant` sin abrir RLS (rol dedicado + `SECURITY DEFINER`)

**Contexto.** El login recibe `organizationSlug` y todavía NO conoce el tenant, así
que no puede fijar `app.current_tenant` antes de consultar. Pero `organizations`
tiene `FORCE ROW LEVEL SECURITY`, que —a diferencia de `ENABLE`— aplica también al
dueño de la tabla: cualquier consulta sin contexto devuelve cero filas.
**Decisión.** Un rol dedicado `helpdesk_slug_resolver` (NOLOGIN, sin `BYPASSRLS`)
con `GRANT SELECT (id, slug)` a nivel de **columna** sobre `organizations` y una
policy propia acotada a `SELECT`. La función `iam_resolve_tenant_by_slug(text)` es
`SECURITY DEFINER`, propiedad de ese rol, con `search_path` fijo, y solo
`helpdesk_app` puede ejecutarla.
**Alternativas descartadas.**
- *Dar `BYPASSRLS` al rol de app*: resolvería el login y destruiría la garantía del
  ADR-0010 para todo lo demás. Desproporcionado.
- *`SECURITY DEFINER` propiedad del owner*: seguiría filtrada por `FORCE RLS`, y si
  el owner fuese superusuario expondría toda la base ante un fallo en la función.
- *Tabla desnormalizada `slug -> id` sin RLS*: duplica estado y hay que mantenerlo
  sincronizado; el mismo dato en dos sitios acaba divergiendo.
**Consecuencias.** (+) Privilegio mínimo real: aunque la función se viera
comprometida, lo máximo que expone es el mapeo `slug -> id`, que el propio cliente
ya provee en el login. (+) No depende de que el rol de migración sea superusuario.
(−) La migración debe poder hacer `GRANT helpdesk_slug_resolver TO CURRENT_USER`
para transferir la propiedad de la función. (−) Una excepción a RLS es una excepción:
queda documentada aquí y acotada a dos columnas de una tabla.
**Revisar si.** Se añade una segunda consulta pre-autenticación (p. ej. SSO por
dominio de email): conviene evaluar un esquema `public_lookup` separado en vez de ir
sumando funciones definer.


## ADR-0013 — Rate limiting en autenticación

**Contexto.** `/auth/login` y `/auth/register` son los endpoints que un atacante usa
para fuerza bruta. Además, argon2id tarda ~50 ms **a propósito**: eso encarece un
ataque por diccionario, pero convierte al login en un vector de denegación de
servicio barato si se puede llamar sin límite.
**Decisión.** `@nestjs/throttler` registrado como guard **global** (`APP_GUARD`) con
un límite general de red de seguridad (300/min), y límites estrictos por endpoint vía
`@Throttle`: login 5/15 min, registro 5/hora, refresh 30/15 min (ver
`src/modules/iam/infrastructure/http/throttle.policy.ts`). Almacenamiento **en
memoria**. Los límites son constantes en código, no configuración por entorno.
**Alternativas descartadas.**
- *Almacenamiento en Redis*: correcto en multi-instancia, pero adelantaría Redis de
  la fase 5 y haría `REDIS_URL` obligatorio antes de tiempo. Con una sola instancia
  el resultado es idéntico.
- *Rate limit en el reverse proxy*: cero código, pero la política no quedaría
  versionada, ni revisable en el diff, ni cubierta por tests.
- *Límites configurables por variable de entorno*: un límite de seguridad que se
  afloja con una variable acaba aflojado. El único escape hatch (`THROTTLE_SKIP`)
  exige además `NODE_ENV=test`, así que en producción no puede activarse.
**Consecuencias.** (+) Ninguna ruta nueva nace desprotegida: el guard es global y los
endpoints sensibles endurecen, en vez de tener que acordarse de proteger cada una.
(+) La política está versionada y cubierta por e2e (`auth-rate-limit.e2e-spec.ts`).
(−) El contador es **por instancia**: con N réplicas el límite efectivo es N veces
mayor. (−) Se limita por IP+ruta, no por cuenta: un atacante que agote el límite deja
fuera al usuario legítimo que comparta esa IP — hay un test que lo deja explícito en
vez de esconderlo. (−) Detrás de un proxy hay que configurar `trust proxy`, o todas
las peticiones compartirán la IP del proxy y el límite se aplicará a todo el tráfico
junto (resuelto en la adenda de abajo).
**Revisar si.** Se despliega más de una instancia (→ mover el almacenamiento a Redis,
ya disponible desde la fase 5), o si el bloqueo del usuario legítimo resulta un
problema real (→ limitar por cuenta además de por IP).

**Adenda (2026-09-30) — detrás de un proxy.** El despliegue pone a Caddy delante de
la API, así que el pendiente de arriba deja de ser teórico: sin configurar nada,
cinco logins fallidos de cualquier persona bloquean el login de todas.
**Decisión.** Variable `TRUST_PROXY_HOPS`, un **número de saltos**: `0` por defecto
(se ignora `X-Forwarded-For`, igual que antes) y `1` en producción. Express toma
entonces la IP que añadió el último proxy y descarta lo que el cliente escribió a
la izquierda. Se aplica en `configureApp`, así que los e2e ejercitan el mismo
código que producción.
**Alternativas descartadas.**
- *`trust proxy: true`*: Express confía en la cabecera entera y toma la IP de más a
  la izquierda, que la escribe el cliente. Bastaría una IP inventada por intento
  para saltarse el límite.
- *Confiar por rango de red* (`'loopback, uniquelocal'`): depende de las IPs que
  asigne Docker a su red, que no controlamos. Un número de saltos describe la
  topología, que sí controlamos.
**Consecuencias.** (+) Cada cliente tiene su contador y falsificar la cabecera no
sirve: lo cubre `trust-proxy.e2e-spec.ts`. (−) Es correcto **solo si la API no es
alcanzable sin pasar por el proxy**. Si se publicara su puerto, un cliente directo
podría mandar un `X-Forwarded-For` que sí se creería. Por eso el compose de
producción no publica el puerto de la API.


## ADR-0014 — Autorización por jerarquía de roles (no permisos granulares)

**Contexto.** El rol es por membership y hay tres (ADMIN, AGENT, VIEWER — ADR-0011).
Hay que decidir cómo se expresa "quién puede hacer qué" en las rutas.
**Decisión.** Jerarquía ordinal **ADMIN > AGENT > VIEWER**. Cada endpoint declara un
rango **mínimo** con `@MinRole(...)`, y cualquier rol superior lo satisface. El orden
vive en el dominio (`hasAtLeastRole` en `domain/role.ts`), no en el guard: "un ADMIN
puede todo lo que puede un AGENT" es una regla de negocio, no de HTTP. `RolesGuard`
se registra como guard global pero no exige nada si la ruta no declara `@MinRole`.
**Alternativas descartadas.**
- *Permisos granulares* (`ticket:read`, `sla:configure`) con roles como conjuntos de
  permisos: es lo correcto cuando los roles dejan de ser un orden total. Con tres que
  sí lo son, añade una tabla, una capa de indirección y **cero capacidad real hoy**.
- *`@Roles('AGENT', 'ADMIN')` enumerando los permitidos*: duplica la jerarquía en cada
  ruta; añadir un rol obligaría a revisar todos los decoradores del proyecto.
- *Guard "deny by default"* (exigir rol en toda ruta): obligaría a marcar
  explícitamente como públicas rutas que ya protege `JwtAuthGuard`, y esa doble
  anotación es justo donde se cuelan los olvidos.
**Consecuencias.** (+) Añadir un rol intermedio es cambiar un número en `ROLE_RANK`.
(+) La regla se testea sin HTTP ni base de datos. (+) El nombre `@MinRole` delata la
semántica: `@Roles('AGENT')` se leería como "solo AGENT". (−) **El rol viaja en el
access token**: degradar a alguien no surte efecto hasta que el token caduque (15 min)
o renueve. Se acepta a cambio de no consultar la base de datos en cada request; el
refresh ya re-lee el membership, así que se corrige solo. Hay un e2e que lo deja
explícito en vez de esconderlo. (−) La jerarquía asume un orden total: un rol como
"BILLING", que pudiera facturar pero no ver tickets, no encaja.
**Revisar si.** Aparece un rol que no encaja en el orden total (→ migrar a permisos
granulares), o si el desfase de 15 minutos resulta inaceptable para alguna operación
crítica (→ lista de revocación, o lookup del membership solo en esas rutas).

---

## ADR-0015 — Ciclo de vida del ticket como máquina de estados en el dominio

**Contexto.** Un ticket pasa por estados y no todos los saltos tienen sentido: cerrar
algo que nunca se resolvió, o reabrir un caso archivado hace meses, son incoherencias
que después ensucian cualquier métrica. La alternativa habitual —un campo `status`
que el cliente escribe libremente— traslada esa responsabilidad al front, es decir,
la pierde.
**Decisión.** Estados `OPEN`, `IN_PROGRESS`, `RESOLVED`, `CLOSED` con las transiciones
declaradas como **datos** en `domain/ticket-status.ts`:

| Desde | Hacia |
| --- | --- |
| `OPEN` | `IN_PROGRESS`, `RESOLVED` |
| `IN_PROGRESS` | `RESOLVED`, `OPEN` |
| `RESOLVED` | `CLOSED`, `OPEN` |
| `CLOSED` | — (terminal) |

La entidad `Ticket` es la única que puede cambiar el estado, a través de
`changeStatus(next, now)`, que devuelve `Result` (ADR-0005). No hay setters públicos:
con un `ticket.status = 'CLOSED'` la máquina de estados sería decorativa. Los
timestamps del ciclo de vida (`resolvedAt`, `closedAt`) se **derivan** de la
transición, nunca llegan de fuera.
**Alternativas descartadas.**
- *`status` editable sin reglas.* Más rápido, pero la invariante deja de existir: la
  primera integración que escriba por API la rompe.
- *Transiciones en el caso de uso.* El ticket creado desde el email entrante (fase 5)
  y el movido por el motor de SLA (fase 6) no pasan por el mismo caso de uso, así que
  la regla habría que repetirla —y algún día divergiría.
- *Constraint `CHECK` en Postgres.* Valida el valor, no el salto: la base de datos no
  sabe de qué estado venía la fila.
**Consecuencias.** (+) La tabla de transiciones se lee de un vistazo y se testea
exhaustivamente recorriendo el producto cartesiano de estados: añadir un estado sin
decidir sus transiciones hace fallar la suite. (+) La fase 6 podrá consultar la misma
tabla sin duplicar la regla. (+) Una transición ilegal es un 409, no un 400 ni un 500.
(−) `CLOSED` es terminal, así que "reabrir" una incidencia zanjada obliga a crear un
ticket nuevo. Es deliberado: reabrir mezclaría dos incidencias en una fila, con sus
tiempos de SLA solapados. (−) Añadir un estado toca dominio, enum de Prisma y
migración.
**Revisar si.** Aparecen estados dependientes de configuración por tenant (workflows
personalizables) → la tabla dejaría de ser una constante y pasaría a ser datos.

**Adenda (2026-11-12, ADR-0029).** Estado nuevo `WAITING_ON_CUSTOMER`:

| Desde | Hacia |
| --- | --- |
| `IN_PROGRESS` | `RESOLVED`, `OPEN`, **`WAITING_ON_CUSTOMER`** |
| `WAITING_ON_CUSTOMER` | `IN_PROGRESS`, `RESOLVED` |

Solo se entra con alguien trabajando el ticket; no se sale a `OPEN` (primero se
retoma) ni a `CLOSED` (solo se cierra lo resuelto). Es la primera transición que
ocurre sin que nadie la pida: la decide el agregado cuando el cliente comenta.

---

## ADR-0016 — Unidad de trabajo explícita: el AuditLog en la misma transacción

**Contexto.** Cada cambio sobre un ticket debe dejar rastro. Si el ticket y su
registro de auditoría se escriben por separado, existe un instante en el que uno está
guardado y el otro no; un fallo justo ahí deja el historial incompleto **para
siempre**, y sin forma de detectarlo. El problema es que ambos viven en repositorios
distintos, y hasta ahora cada repositorio abría su propia transacción con
`PrismaService.withTenant` (ADR-0009).
**Decisión.** Un puerto `TransactionManager` en el shared-kernel con un único método,
`run(tenantId, fn)`. Su adapter Prisma abre la transacción, fija el contexto de tenant
y publica el cliente transaccional en un `AsyncLocalStorage`; los repositorios lo
recogen a través de `PrismaRepository.runInTenant`, que se engancha a la transacción
en curso si la hay y abre una propia si no. El adapter es **reentrante**: si ya hay
transacción viva, se reutiliza.

Los casos de uso envuelven su trabajo en `runTransactional`, que traduce un `Result`
de error en un ROLLBACK. Hace falta porque con ADR-0005 los errores de negocio son
valores, no excepciones, y una transacción solo revierte si algo se lanza: sin ese
puente, un caso de uso que reserva un número de ticket y luego rechaza la entrada
haría COMMIT y dejaría el número consumido.
**Alternativas descartadas.**
- *Pasar el cliente de transacción como parámetro de cada método de repositorio.* El
  parámetro sería del tipo `Prisma.TransactionClient`, así que las interfaces de los
  puertos —que viven en el dominio— tendrían que nombrar un tipo de Prisma. Rompe la
  regla de dependencias justo donde más importa.
- *Que el repositorio de tickets escriba también la auditoría.* Atómico y sin
  abstracción nueva, pero mete una regla de negocio dentro de un adapter y no sirve
  como base para el outbox.
- *Auditoría asíncrona por cola.* Es lo correcto a gran escala, pero introduce
  justo la ventana de inconsistencia que se quería eliminar.
**Consecuencias.** (+) No existe un cambio sin su rastro: lo garantiza el motor, no
la disciplina de quien programa. (+) Es el andamio exacto que necesita el
transactional outbox (ADR-0007): en la fase 5 el evento se escribirá en la misma
transacción. (+) Los repositorios sirven igual dentro y fuera de una unidad de
trabajo, y ningún caso de uso sabe en cuál de los dos modos corre. (−) El
`AsyncLocalStorage` es contexto implícito: leyendo un repositorio aislado no se ve de
dónde sale su transacción. Se mitiga concentrándolo en un solo fichero y
documentándolo. (−) Anidar transacciones largas alarga los bloqueos; el contador de
numeración es el punto sensible.
**Revisar si.** Aparecen transacciones que cruzan bounded contexts (→ señal de que
hay que separar servicios y pasar a consistencia eventual), o si el
`AsyncLocalStorage` se pierde en algún borde nuevo (workers de BullMQ, gateway de
WebSocket) que habrá que instrumentar igual que el middleware de tenant.

---

## ADR-0017 — Numeración visible correlativa por tenant

**Contexto.** Quien usa un helpdesk se refiere a "el ticket #1042", no a un UUID. Hace
falta un número corto, legible y **por organización**: la serie de cada tenant empieza
en 1 y no revela cuántos tickets tienen los demás.
**Decisión.** Una tabla `ticket_counters` con una fila por tenant. El número se reserva
con un UPSERT que toma el bloqueo exclusivo de esa fila y devuelve el valor asignado:

```sql
INSERT INTO ticket_counters (tenant_id, next_number) VALUES ($1, 2)
ON CONFLICT (tenant_id) DO UPDATE SET next_number = ticket_counters.next_number + 1
RETURNING next_number - 1;
```

Corre **dentro de la transacción que crea el ticket** (ADR-0016), así que el bloqueo se
mantiene hasta el commit y dos altas simultáneas del mismo tenant se serializan. El
UUID sigue siendo la clave primaria y lo que viaja por la API; el número es solo para
las personas. La unicidad la respalda además un índice `UNIQUE (tenant_id, number)`.
**Alternativas descartadas.**
- *Una `SEQUENCE` de Postgres.* Es global al esquema, no por tenant; no es
  transaccional, así que cada rollback deja un hueco; y una secuencia por organización
  significa ejecutar DDL cada vez que alguien se registra.
- *`SELECT MAX(number) + 1`.* Necesita el nivel de aislamiento más estricto o un
  índice único más reintentos ante colisión, y se degrada según crece la tabla.
- *`SELECT ... FOR UPDATE` explícito seguido de `UPDATE`.* Misma garantía que el
  UPSERT pero en dos viajes a la base de datos, y sin resolver la creación de la fila
  la primera vez.
**Consecuencias.** (+) Serie correlativa y sin huecos por tenant, incluso con altas
concurrentes y con altas rechazadas (el rollback devuelve el número). (+) La fila del
contador se crea sola: registrarse no tiene que sembrar nada. (+) Tenants distintos
tocan filas distintas y no se estorban. (−) Las altas **del mismo tenant** se
serializan en esa fila: es el cuello de botella conocido de este diseño. Con el
volumen de un helpdesk es irrelevante; con miles de altas por segundo por
organización, no. (−) El número no puede reasignarse ni reutilizarse.
**Revisar si.** Un solo tenant necesita más altas concurrentes de las que aguanta el
bloqueo de fila → bloques de numeración reservados por instancia, aceptando huecos.

---

## ADR-0018 — Eventos de integración "gordos" en un outbox transaccional

**Contexto.** La fase 5 necesita reaccionar a lo que pasa en `ticketing` sin acoplar
al caso de uso con quien reacciona. La tentación es publicar en la cola desde el
propio caso de uso, pero eso rompe en los dos sentidos: si la transacción revierte
después de publicar, queda un mensaje anunciando algo que nunca ocurrió; y si el
proceso muere entre el commit y el publish, el evento se pierde sin dejar rastro.
Son dos sistemas (Postgres y Redis) sin transacción común.

**Decisión.** Tres piezas.

1. **El agregado emite.** `Ticket` extiende `AggregateRoot<TicketId, TicketingEvent>` y
   registra `ticket.created`, `ticket.assigned`, `ticket.unassigned`,
   `ticket.status_changed` y `comment.added` en los mismos métodos que aplican el
   cambio. El segundo parámetro de tipo acota qué puede emitir, así que
   `pullDomainEvents()` sale tipado y añadir un evento sin declararlo no compila.
2. **Se escriben en `outbox_messages` dentro de la transacción del cambio**
   (ADR-0016), vía `EventRecorder` + el puerto `OutboxWriter`. Un solo commit decide
   si existen las dos cosas o ninguna.
3. **Eventos "gordos" y versionados.** El `payload` lleva el estado relevante EN EL
   MOMENTO del evento, y `version` versiona su forma.

**Alternativas descartadas.**
- *Publicar en la cola desde el caso de uso.* Es el fallo que el patrón existe para
  evitar: no hay transacción que abarque Postgres y Redis.
- *Eventos "finos" (solo ids).* Filas más pequeñas y sin duplicar datos, pero el
  consumidor tendría que releer el ticket y vería el estado ACTUAL, no el del momento
  del evento — reaccionaría a algo que ya no es cierto. Además le obligaría a abrir
  contexto de tenant solo para leer.
- *Emitir los eventos desde el caso de uso.* El ticket creado desde el email entrante
  o movido por el motor de SLA no pasa por el mismo caso de uso; la regla se
  duplicaría y algún día divergiría. Es el mismo razonamiento del ADR-0015.
- *Publicar los eventos desde el repositorio* al guardar. Atómico, pero mete
  orquestación en un adapter y esconde en un `save()` un efecto que no se ve.

**Consecuencias.** (+) Ningún cambio se queda sin su evento y ningún evento anuncia un
cambio revertido; lo garantiza el motor, no la disciplina. (+) El consumidor no
depende del esquema de la base de datos: puede reaccionar aunque el ticket haya
cambiado o se haya borrado. (+) `tenantId` viaja en el evento, que es lo único que
permite a un worker —sin JWT— reabrir el contexto de RLS. (−) El payload duplica
datos que también están en `tickets`: si el evento se diseñó mal, corregirlo obliga a
subir `version` y a mantener dos formas vivas mientras haya consumidores viejos. (−)
La tabla crece indefinidamente hasta que exista una política de purga de mensajes ya
publicados. (−) La entrega es **at-least-once**: el mismo evento puede llegar dos
veces, así que los consumidores tienen que ser idempotentes (ADR-0019).

**Nota de seguridad (se resuelve en 5b).** `outbox_messages` tiene RLS como todo lo
demás, así que el rol de aplicación solo ve el outbox de su tenant. Correcto para
escribir, pero significa que el publicador —que corre fuera de toda request y por
tanto sin `app.current_tenant`— no ve NI UNA fila: las policies son fail-closed y
`FORCE RLS` aplica también al dueño de la tabla. Se resolverá con un rol dedicado y
funciones `SECURITY DEFINER`, el mismo patrón de mínimo privilegio del ADR-0012.

**Revisar si.** Los payloads empiezan a necesitar campos de otros agregados (→ señal
de que falta un bounded context o una vista), o si el volumen del outbox obliga a
particionar o a purgar de forma agresiva.

---

## ADR-0019 — Publicador por polling, idempotencia en base de datos y DLQ

**Contexto.** El ADR-0018 dejó los eventos en `outbox_messages`. Falta llevarlos a una
cola, consumirlos sin repetir efectos y decidir qué pasa con lo que no se puede
procesar. Tres decisiones acopladas.

**Decisión 1 — El publicador hace polling.** Un bucle reclama lotes con
`SELECT ... FOR UPDATE SKIP LOCKED`, los encola en BullMQ y los marca publicados.
`SKIP LOCKED` permite varias instancias publicando a la vez sin duplicar trabajo:
cada una se lleva filas distintas.

*Alternativas descartadas.* `LISTEN/NOTIFY` solo: un NOTIFY que llega mientras el
publicador reinicia se pierde, y ese evento no se publicaría nunca — justo la
garantía por la que existe el outbox. Híbrido NOTIFY + polling de red: da latencia
mínima, pero añade un trigger y dos caminos que deben converger, a cambio de un
segundo de latencia que a este producto no le cambia nada.

**Decisión 2 — El publicador usa un rol dedicado.** `outbox_messages` tiene RLS
fail-closed y `FORCE ROW LEVEL SECURITY`, que aplica también al dueño de la tabla.
El publicador corre fuera de toda request, sin JWT, así que `app.current_tenant` está
vacío y **no vería ni una fila**. Se resuelve con `helpdesk_outbox_publisher`: rol
NOLOGIN, sin BYPASSRLS, con GRANT a nivel de COLUMNA sobre esa única tabla, dueño de
tres funciones `SECURITY DEFINER` (`outbox_claim_batch`, `outbox_mark_published`,
`outbox_mark_failed`) que solo `helpdesk_app` puede ejecutar. Es exactamente el
patrón del ADR-0012 para el login por slug.

*Alternativa descartada.* Iterar tenants fijando el contexto uno a uno: correcto,
pero el coste crece linealmente con el número de organizaciones y la mayoría no
tendrá nada pendiente.

**Decisión 3 — Idempotencia en dos capas.** El `jobId` de BullMQ es el id del mensaje,
así que encolar dos veces el mismo evento no crea dos jobs. Pero esa ventana dura lo
que la retención de jobs en Redis, así que la garantía REAL es la tabla
`processed_messages`, con clave primaria `(consumer, event_id)`, escrita en la MISMA
transacción que el efecto del job (ADR-0016). Si el trabajo revierte, la marca
revierte con él y el reintento vuelve a intentarlo; marcarla fuera de la transacción
sería peor que no marcarla, porque un fallo dejaría el evento como "hecho" sin estarlo.

La clave es `(consumer, event_id)` y no solo `event_id` para que varios consumidores
puedan procesar el mismo evento, cada uno una vez.

*Alternativas descartadas.* Solo `jobId`: depende de la retención de Redis. Handlers
"naturalmente idempotentes": elegante mientras el efecto sea un UPDATE, inservible en
cuanto un job mande un email o llame a un tercero.

**Decisión 4 — Reintentos y DLQ.** 5 intentos con backoff exponencial desde 1s. Al
agotarlos, el job se copia a una cola `dead-letter` con el motivo y el número de
intentos. Los fallos **permanentes** (versión de evento desconocida, evento que la
cola no maneja) van a la DLQ en el primer intento: reintentar no los arregla.
Hoy la DLQ es solo observabilidad; no hay endpoint de reproceso.

**Decisión 5 — Primer consumidor: auto-asignación round-robin.** Al crearse un
ticket, se reparte entre los miembros que pueden atender (AGENT y ADMIN, por la
jerarquía del ADR-0014). El agente sale de `(number - 1) % agentes.length`, usando la
numeración por tenant del ADR-0017. Es round-robin de verdad **sin estado**: sin
contador que mantener, sin fila que bloquear, y determinista — reprocesar el mismo
evento da el mismo agente, así que la idempotencia no depende solo de la tabla de
procesados. El precio es que dar de alta o baja a un agente desplaza la rotación.

**Consecuencias.** (+) Ningún evento se pierde: si el publicador muere, lo pendiente
se recoge en el siguiente arranque. (+) `WORKER_ENABLED` permite separar mañana el
despliegue de workers del de la API sin tocar código; hoy conviven en un proceso.
(+) Los `skipped` del caso de uso (ticket borrado, sin agentes, ya asignado) se
devuelven como éxito, no como error: son situaciones definitivas, y tratarlas como
fallo las mandaría a la DLQ para nada. (−) La entrega es **at-least-once**: los jobs
se encolan antes del commit que los marca publicados, así que un fallo justo ahí los
duplica. Es deliberado — duplicar lo resuelve `processed_messages`, perder no lo
resuelve nadie. (−) Los bloqueos del lote viven hasta el commit del publicador, así
que encolar lento alarga la ventana. (−) `outbox_messages` y `processed_messages`
crecen sin límite hasta que exista una política de purga.

**Revisar si.** La latencia del polling molesta (→ añadir NOTIFY encima, conservando
el polling como red), varias instancias se estorban en el mismo lote (→ reducir el
tamaño de lote), o la DLQ se llena lo bastante como para necesitar reproceso
automático.

---

## ADR-0020 — Modelo de SLA: dos relojes, política por tenant y calendario enchufable

**Contexto.** La fase 6 mide si la organización atiende a tiempo. Es la primera fase
con **configuración por tenant**, y la primera en la que una regla de negocio depende
de QUIÉN hizo algo y de CUÁNDO lo hizo, no solo de qué pasó.

**Decisión 1 — Dos relojes independientes por ticket.** `RESPONSE` (cuánto tarda la
organización en contestar) y `RESOLUTION` (cuánto tarda en arreglarlo). Se miden por
separado porque incumplen por motivos distintos: responder rápido y resolver tarde es
un problema de capacidad; tardar en responder es un problema de atención, y el cliente
lo nota mucho antes. Un solo reloj mezclaría las dos señales.

**Decisión 2 — `sla_policies` guarda solo lo que el tenant sobreescribe.** Los valores
por defecto (`DEFAULT_SLA_POLICY`) viven en el DOMINIO y el merge es **por prioridad**
(`resolvePolicy`): una organización puede endurecer solo `URGENT` y quedarse con el
resto. Así, una organización que nunca configuró nada —o que se registró antes de esta
fase— tiene SLA igualmente, y `iam` no necesita saber que el SLA existe para sembrar
filas al provisionar.

**Decisión 3 — "Respondido" = el primer comentario de quien responde EN NOMBRE de la
organización.** Un comentario del propio solicitante no para el reloj: si lo parara,
bastaría con que el cliente insistiera para que su SLA se diera por cumplido. Eso
obliga a saber el rol del autor, así que `comment.added` sube a **v2** y lo lleva en el
payload: el rol de una persona cambia con el tiempo y lo que cuenta es el que tenía AL
COMENTAR (mismo razonamiento que los eventos gordos del ADR-0018). El rol sale del JWT
verificado, nunca del cuerpo de la petición.

**Decisión 4 — El vencimiento se calcula al arrancar y se persiste.** `due_at` es
inmutable: si el tenant cambia su política mañana, los relojes ya en marcha conservan
el objetivo con el que nacieron. Cambiar las reglas a mitad de partida es justo lo que
un SLA no debe permitir. Por lo mismo, el estado del reloj se **deriva** de las fechas
(`stopped_at`, `breached_at`) en vez de guardarse en un campo `status` que podría
contradecirlas.

> **Revocada en parte por el ADR-0029 (2026-11-12).** `due_at` sigue siendo
> inmutable frente a cambios de **política**, que era el motivo de esta
> decisión. Pero ahora lo mueve una pausa del propio ticket (esperando al
> cliente): al reanudar se corre lo que duró la pausa, porque ese tiempo no
> cuenta. Ya no guarda el objetivo original; el estado del reloj, en cambio,
> se sigue derivando de las fechas (ahora también de `paused_at`).

**Decisión 5 — El calendario es una interfaz, hoy con una sola implementación.** Los
minutos se cuentan sobre `SlaCalendar`; existe `CALENDAR_24_7` y nada más. La interfaz
no es especulación: es la costura por la que entrará el horario laboral por tenant con
su zona horaria. Aislar hoy lo que sabemos que va a cambiar cuesta una interfaz; no
aislarlo cuesta reescribir cada sitio donde se sumó tiempo a mano.

**Decisión 6 — La política se configura POR PRIORIDAD, y leerla ya es cosa de
`ADMIN`.** `GET /sla-policy` devuelve siempre las cuatro prioridades diciendo si cada
objetivo lo pactó la organización o viene de fábrica (`source`); `PUT
/sla-policy/:priority` fija una y `DELETE /sla-policy/:priority` la devuelve al valor
por defecto. Tres detalles deliberados:

- *Por prioridad y no la política entera.* Un `PUT` de las cuatro obligaría al cliente a
  reenviar lo que no está tocando, y dos administradores editando prioridades distintas
  se pisarían el trabajo sin enterarse.
- *`source` en la respuesta.* Sin él, quien va a cambiar el SLA no distingue "esto lo
  pactamos así" de "esto no lo ha tocado nadie", que es justo lo que necesita saber
  antes de tocarlo.
- *`ADMIN` también para LEER*, a diferencia del resto del módulo, donde leer es de
  `VIEWER`. Aquí no se mira un ticket: se mira lo que la organización se ha comprometido
  a cumplir. Un usuario final que lee "resolución en 4 horas" tiene en la mano un
  argumento contractual que nadie le prometió por este canal.

La validación que relaciona los dos plazos —no se puede prometer resolver ANTES de
responder— vive en el dominio (`makeSlaTarget`), no en el DTO: los dos números son
válidos por separado y `class-validator` los dejaría pasar. El cambio y su entrada de
auditoría (`sla.policy_changed`) van en la misma transacción (ADR-0016). Esa entrada
apunta al TENANT y no a la fila de `sla_policies`: la entidad auditada es "la política
de esta organización", y el id de la fila no sirve como identidad estable porque un
reset la borra y el siguiente cambio crea otra con id nuevo, partiendo el historial en
trozos inconexos. La prioridad concreta viaja en `metadata` — `entity_id` es una
columna `uuid` en todo el sistema, así que tampoco cabría ahí.

**Alternativas descartadas.**
- *Un `PUT /sla-policy` con la política completa.* Más REST de manual, pero convierte
  cualquier edición en una carrera entre administradores.
- *Objetivos como constantes del dominio, sin tabla.* Más simple, pero deja fuera lo
  que hace de esto un producto multi-tenant: que cada organización pacte lo suyo.
- *Sembrar las cuatro filas al registrar la organización.* Obligaría a `iam` a conocer
  el SLA (dos bounded contexts acoplados) y dejaría sin política a los tenants
  anteriores a la fase.
- *Parar el reloj de respuesta con la asignación o con el paso a `IN_PROGRESS`.*
  Ninguna de las dos cosas la ve el cliente. Se puede asignar un ticket y no
  contestarlo en un día.
- *Consultar el rol del autor al procesar el evento en vez de llevarlo dentro.* Daría
  el rol ACTUAL: reprocesar el mismo evento meses después podría dar otro resultado.
- *Horario laboral desde el primer día.* Es lo que hace un producto de verdad, pero
  multiplica el coste del cálculo (festivos, zonas horarias, cambios de hora) sin
  añadir nada a lo que esta fase demuestra. Queda detrás de `SlaCalendar`.

**Consecuencias.** (+) Cada organización configura su compromiso y el sistema sigue
funcionando si no configura nada. (+) Esa configuración es auditable y reversible: el
`DELETE` devuelve al valor de fábrica y queda registrado quién lo hizo. (+) El cálculo del vencimiento es una función pura,
testeable sin base de datos ni relojes reales. (+) Un reloj no puede quedar en un
estado imposible: sus tres situaciones se derivan de dos fechas. (−) `comment.added`
tiene dos versiones vivas, y el consumidor descarta las v1 (no existía ninguna con
consumidor, pero la regla queda escrita). (−) Los relojes en marcha ignoran los
cambios de política, lo que es correcto pero puede sorprender a quien acaba de
endurecer su SLA. (−) Con 24/7, un ticket abierto un viernes por la tarde incumple el
sábado por la noche.

**Revisar si.** Aparece un tenant que necesita horario laboral (→ implementar otro
`SlaCalendar`), o hacen falta más relojes que respuesta y resolución (→ el `kind` ya es
un enum, pero habrá que decidir quién los arranca).

---

## ADR-0021 — Temporizadores durables en base de datos y barrido, no jobs retardados

**Contexto.** Hay que detectar que un reloj venció SIN que nadie toque el ticket: el
incumplimiento se caracteriza justamente por que no pasó nada. Es la primera vez que el
sistema tiene que reaccionar al paso del tiempo.

**Decisión 1 — La tabla es la fuente de verdad; un barrido periódico la revisa.**
`sla_timers` guarda cada reloj y `SlaSweeper` pregunta cada `SLA_SWEEP_INTERVAL_MS`
qué venció. La alternativa evidente —un `delayed job` de BullMQ por reloj— pone el
reloj en Redis: si Redis se vacía, desaparecen TODOS los vencimientos pendientes en
silencio y nadie se entera hasta que un cliente reclama. Con la tabla, un Redis nuevo
no pierde nada, y además se puede preguntar "qué tickets están a punto de vencer", que
es media pantalla de cualquier panel de soporte. El precio es la precisión: el
incumplimiento se detecta con el retraso del intervalo, que para objetivos medidos en
horas sobra.

**Decisión 2 — El barrido cruza tenants para LEER; el trabajo se hace por tenant.**
Mismo problema que el publicador del outbox (ADR-0019): el barrido corre fuera de toda
request, sin `app.current_tenant`, y con policies fail-closed no vería nada. Se
resuelve igual —rol `helpdesk_sla_sweeper` NOLOGIN, sin `BYPASSRLS`, dueño de una
función `SECURITY DEFINER` con `search_path` fijo— pero la exposición es **mucho
menor**: `sla_due_timers` devuelve solo `(id, tenant_id)`. Con ese par, cada reloj se
procesa dentro de `withTenant`, bajo RLS normal, como cualquier request. El rol ni
siquiera necesita `UPDATE`.

**Decisión 3 — Idempotencia por condición, no por bloqueo.** La función no usa
`FOR UPDATE`: `MarkSlaBreached` vuelve a comprobar dentro de su transacción que el
reloj sigue corriendo y sigue vencido. Entre que el barrido lee la lista y llega al
trabajo, alguien puede haber respondido; confiar en la lectura del barrido registraría
incumplimientos de SLA que sí se cumplieron. Como efecto secundario, dos barridos
concurrentes son inofensivos y el barrido no mantiene una transacción abierta mientras
trabaja.

**Decisión 4 — Arrancar y parar relojes son consumidores de la cola `sla`.** Reaccionan
a `ticket.created`, `comment.added` y `ticket.status_changed` con la idempotencia del
ADR-0019 (`processed_messages` en la misma transacción), reforzada por el `UNIQUE
(ticket_id, kind)` de la tabla. **Todo se fecha con el `occurredAt` del evento, no con
el instante del job**: si la cola va lenta, contar desde el job regalaría ese tiempo y
bastaría con un worker saturado para que ningún SLA incumpliera nunca.

**Alternativas descartadas.**
- *Un `delayed job` por reloj.* Preciso al segundo y sin barrido, pero el estado del
  SLA viviría en Redis y cancelar un reloj sería localizar y borrar un job.
- *Un cron externo (o `pg_cron`).* Menos código, pero mete una pieza de infraestructura
  fuera del despliegue de la aplicación y sin acceso al dominio.
- *Calcular el incumplimiento al leer el ticket (perezoso).* Cero infraestructura, pero
  un breach que nadie mira no existe: no se puede auditar, ni notificar, ni escalar.
- *Marcar el breach directamente en SQL desde el barrido.* Más rápido, pero saltaría la
  auditoría y el evento de dominio, que es lo que hace accionable un incumplimiento.

**Consecuencias.** (+) Los relojes sobreviven a un Redis vacío y son consultables. (+)
El incumplimiento deja rastro completo: fila marcada, `AuditLog` a nombre del sistema y
evento `sla.breached` en el outbox, listo para que la fase de notificaciones o de
escalado se enganche sin tocar el motor. (+) El barrido se apaga con `WORKER_ENABLED`,
igual que el resto de los workers. (−) Precisión limitada por el intervalo. (−) Una
consulta más cruzando tenants, aunque reducida a dos columnas. (−) `sla_timers` crece
con cada ticket y hoy nadie la purga.

**Revisar si.** Hace falta detectar el vencimiento al segundo (→ delayed job encima del
barrido, conservándolo como red), el barrido no llega a tiempo con el volumen (→ lotes
más grandes o varias instancias, que ya son seguras), o aparecen avisos previos al
vencimiento del tipo "queda el 20%" (→ un segundo umbral en la misma tabla).

**Adenda (2026-11-12, ADR-0029).** La "idempotencia por condición" se cumplía al
LEER pero no al ESCRIBIR: parar e incumplir guardaban con un upsert sin
condición, y una pausa concurrente con el barrido se pisaba. Las transiciones
del reloj pasan a `SlaTimerRepository.transition(timer, expected)`, un
`UPDATE ... WHERE` condicionado al estado leído que devuelve si escribió; `save`
queda solo para el alta. `sla_due_timers` ignora los relojes en pausa
(`paused_at IS NULL`) y el rol del barrido tiene `GRANT SELECT (paused_at)`.

---

## ADR-0022 — Transporte de tiempo real: handshake con JWT, rooms por tenant y adapter de Redis

**Contexto.** La fase 7 empuja datos hacia el cliente. Es la primera vez que el
aislamiento entre organizaciones tiene que sostenerse FUERA del ciclo request/response:
no hay middleware de contexto corriendo por petición, ni RLS mirando cada consulta. Un
socket abierto es una tubería que dura horas.

**Decisión 1 — El token viaja en el handshake, en `auth.token`.** Se verifica con el
mismo `AccessTokenVerifier` que usa HTTP, y el `tenantId` sale de ahí: NUNCA de lo que
manda el cliente. No va en la query string a propósito — las URLs acaban en logs de
proxies y en el historial del navegador, y un access token en un log es un access token
filtrado.

**Decisión 2 — Un token caducado cierra el socket.** Al conectar se programa el cierre
para el `exp` del propio token, avisando antes con `disconnected` y un motivo. Sin esto
la conexión sobrevive indefinidamente a su credencial: quien perdió el acceso esta
mañana seguiría recibiendo los tickets de la tarde mientras no cerrara la pestaña. El
motivo permite al cliente distinguir "refresca y vuelve" de "no tienes acceso".

**Decisión 3 — Quien decide las rooms es el servidor, al conectar.** Todo socket entra
en `tenant:<id>`, y si su rol es AGENT o superior también en `tenant:<id>:staff`. **El
filtrado por rol se resuelve al ENTRAR, no en cada emisión**: un olvido al emitir
filtraría datos, mientras que un socket que nunca entró en la sala del equipo no puede
recibir lo que se manda ahí por mucho que se falle más adelante.

El cliente sí puede pedir seguir un ticket (`ticket:watch`), pero el nombre de la room
se construye con SU tenant: `tenant:<tenant>:ticket:<id>`. Pedir el ticket de otra
organización mete al socket en una room vacía en vez de en la del vecino, así que no
hace falta consultar la base de datos en cada suscripción para estar seguros.

**Decisión 4 — Adapter de Redis desde el primer día.** Sin él, `server.to(room).emit()`
solo alcanza a los sockets de ESE proceso. Con dos réplicas —el despliegue que el
proyecto asume desde el ADR-0019, cuando separó workers de API— la mitad de los usuarios
se perdería la mitad de los mensajes, de forma intermitente y sin un solo error en los
logs. Redis ya está en el stack por BullMQ, así que el coste es una dependencia.

**Alternativas descartadas.**
- *Ticket de conexión de un solo uso emitido por HTTP.* Más seguro (el token no viaja en
  el handshake), pero añade endpoint, almacenamiento y caducidad propia para resolver un
  problema que `auth.token` ya evita al no ir en la URL.
- *Cookie de sesión.* Ata el WebSocket al mismo origen y complica cualquier cliente que
  no sea el navegador.
- *Comprobar el rol en cada emisión.* Un `if` que se puede olvidar, en vez de una
  propiedad del socket que no se puede saltar.
- *Validar en `ticket:watch` que el ticket existe y es del tenant.* Una consulta por
  suscripción a cambio de una garantía que el nombre de la room ya da.
- *Un solo proceso, documentando el escalado como deuda.* Deja el sistema incorrecto en
  cuanto se despliegue como se dijo que se iba a desplegar.

**Consecuencias.** (+) El aislamiento no depende de acordarse de filtrar: depende de en
qué room entró el socket, decidido por el servidor con un token verificado. (+) Escala
horizontalmente sin cambiar código. (+) El cierre por caducidad da al cliente una señal
clara para reconectar. (−) El adapter abre dos conexiones más a Redis por proceso, y
**hay que cerrarlas explícitamente**: se crean fuera del contenedor de Nest, así que
nadie más las conoce y olvidarlo deja el proceso sin terminar. (−) El rol queda
congelado en el socket hasta que caduque el token, igual que pasa en HTTP.

**Revisar si.** Hacen falta avisos dirigidos a UNA persona (→ room `user:<id>`), la
reconexión masiva tras un despliegue resulta cara (→ backoff en el cliente), o aparece
la necesidad de recuperar lo perdido mientras el socket estuvo caído (→ un cursor de
eventos, no más rooms).

---

## ADR-0023 — Qué se emite y a quién: un DTO de vista, no el evento de integración

**Contexto.** Ya hay un flujo confiable de eventos (outbox, ADR-0018/0019) y un
transporte (ADR-0022). Falta decidir qué se manda por el cable y quién lo recibe.

**Decisión 1 — Emite un consumidor más del outbox, no los casos de uso.** La cola
`realtime` se suma a `ticket-routing` y `sla`. Lo que llega a la pantalla es exactamente
lo que quedó escrito en la misma transacción que el cambio: no se puede anunciar algo
que después se revirtió, ni perder un aviso porque el WebSocket estaba caído en ese
instante — el mensaje sigue en el outbox hasta que se publica. Emitir desde el caso de
uso volvería a meter un efecto externo no transaccional justo donde el ADR-0018 lo sacó.

**Decisión 2 — Por el cable va un DTO de vista, nunca el evento tal cual.** El evento de
integración es "gordo" a propósito y lleva campos internos; además, los dos contratos se
versionan por motivos distintos, y reenviarlo ataría el contrato público del WebSocket a
cada cambio del interno. Concretamente: `comment.added` viaja con el ID del comentario y
**sin su cuerpo**, para que el cliente lo recargue con SUS permisos — así este camino no
puede convertirse nunca en una fuga de contenido.

**Decisión 3 — La audiencia es una decisión de negocio y vive en `application`.**
`BroadcastTicketEvent` traduce cada evento a "quién lo ve y con qué", y se prueba sin
levantar un socket. El reparto actual: un ticket nuevo y los cambios de estado van a
toda la organización; a quién le toca cada ticket (`ticket.assigned`) y **los
incumplimientos de SLA van solo al equipo**. Avisar al solicitante de que se ha
incumplido el compromiso con él es una decisión de producto —y probablemente un email—,
no algo que deba pasar por omisión.

**Decisión 4 — Sin tabla de idempotencia.** Los demás consumidores usan
`processed_messages` porque sus efectos no son repetibles (asignar dos veces, arrancar
dos relojes). Aquí el peor caso de un reproceso es que un cliente reciba dos veces el
mismo aviso y refresque de más. Pagar una escritura en base de datos por cada mensaje
emitido, en el camino con más volumen del sistema, sería caro a cambio de nada.

**Alternativas descartadas.**
- *Reenviar el evento de integración.* Cero traducción, pero publica el contrato interno
  y expone cualquier campo nuevo sin querer.
- *Mandar solo "el ticket X cambió" y que el cliente recargue.* Imposible filtrar de
  más, pero pierde el tiempo real de verdad y añade una petición por evento. Se usa esa
  forma SOLO donde el contenido es sensible (comentarios).
- *Emitir todo a la sala del tenant y filtrar en el cliente.* El navegador recibiría
  datos que no debe ver; filtrar en el cliente es cosmética, no seguridad.

**Consecuencias.** (+) Cierra el cabo suelto de la fase 6: `sla.breached` ya tiene
consumidor. (+) El contrato del WebSocket puede evolucionar sin tocar el del outbox. (+)
Añadir un evento nuevo es una entrada más en `EVENT_ROUTING` y un `case` en el caso de
uso. (−) Cada evento se traduce a mano: uno nuevo sin `case` se ignora en silencio
(devuelve `ignored`, que queda en el registro del job, pero nadie lo vigila). (−) Los
mensajes son at-least-once: el cliente debe tolerar duplicados.

**Revisar si.** El volumen hace que traducir uno a uno se quede corto (→ generar el DTO
desde el esquema del evento), o aparece un consumidor que sí necesita exactly-once (→
`processed_messages`, como los demás).

---

## ADR-0024 — Observabilidad: logs estructurados, correlación hasta el worker y sondas separadas

**Contexto.** El sistema ya hace cosas por su cuenta: un ticket entra por HTTP, un
worker lo auto-asigna, otro le arranca los relojes de SLA, un tercero avisa por
WebSocket, y un barrido puede marcar un incumplimiento media hora después. Cuando algo
va mal, la pregunta no es "¿qué respondió el endpoint?" sino "¿qué pasó a raíz de esto?"
— y esa cadena atraviesa procesos y minutos.

**Decisión 1 — Pino SUSTITUYE al logger de Nest, no convive con él.** Con
`bufferLogs` + `app.useLogger`, los mensajes de arranque, los de los workers y los de
las excepciones salen en el mismo formato que los de las peticiones. Dos loggers en
paralelo dejarían la mitad de lo que pasa en producción fuera de cualquier consulta, y
sería justo la mitad que se mira cuando una instancia no levanta.

**Decisión 2 — El `requestId` viaja con el evento hasta el worker.** Es el corazón de
la fase. `outbox_messages` gana una columna `request_id`; el adapter la rellena leyendo
el `AsyncLocalStorage` de la petición, el publicador la mete en el job, y cada
consumidor abre su trabajo con `runWithJobContext`, que la restaura. Buscar un
identificador en los logs devuelve la petición **y** todo lo asíncrono que provocó.

Va en una COLUMNA y no dentro de `payload`: el payload es el contrato de negocio del
evento (ADR-0018) y meterle metadatos de infraestructura lo ensuciaría para todos los
consumidores. Es nullable porque lo que nace fuera de una petición —el barrido de SLA—
no tiene ninguna a la que apuntar; en ese caso el worker genera una correlación nueva,
para que al menos su propio trabajo se pueda seguir.

**Decisión 3 — La correlación se inyecta con `mixin`, no con `customProps`.**
`customProps` solo alcanza a la línea de acceso que emite `pino-http`; `mixin` se
ejecuta en cada log de la instancia. La diferencia no es cosmética: la línea de acceso
ya se sabe de qué petición es — lo que no se sabe es de cuál viene un job procesado
medio segundo después, y eso solo aparece si la correlación llega a TODOS los logs.

**Decisión 4 — El contexto de correlación es un `AsyncLocalStorage` APARTE del de
tenant.** El de tenant significa "hay un usuario autenticado de esta organización" y de
él dependen los guards de autorización; el `requestId` tiene que existir también en un
login fallido y en un 404, que son precisamente las trazas que se van a buscar. Para
poder filtrar por organización igualmente, el contexto de correlación lleva su propio
`tenantId` opcional, que rellenan los workers a partir del evento.

**Decisión 5 — El `x-request-id` entrante se respeta, pero se sanea.** Se respeta para
no romper la cadena cuando la petición viene de otro servicio. Se sanea porque el valor
lo elige el cliente y acaba en cada línea de log: se recorta a 128 caracteres —si no,
una cabecera de un megabyte infla el volumen de logs a voluntad— y se rechaza lo que
no sea `[\w.:-]+`, porque un salto de línea permite inyectar entradas falsas en un log
de texto plano. **Se vuelve a validar al restaurarlo en el worker**, y no solo al
entrar: para entonces ese valor lleva horas guardado en la base de datos.

**Decisión 6 — Liveness y readiness son rutas distintas.** `/health/live` no toca
ninguna dependencia; `/health/ready` comprueba Postgres y Redis. Si liveness mirara la
base de datos, una caída de Postgres haría que el orquestador reiniciara la aplicación
en bucle: reiniciar no arregla una base de datos caída y encima tira las conexiones que
quedaban. Fallar en readiness, en cambio, es lo correcto — que el balanceador deje de
mandar tráfico a una instancia que no puede servirlo. `/health` se mantiene como alias
de liveness porque hay contenedores apuntando a él desde la fase 1.

Los dos indicadores usan **la conexión que usa la aplicación**, no una propia: el rol
de base de datos es restringido (ADR-0010) y el pool de Redis es el de BullMQ.
Comprobar con un cliente aparte diría que todo va bien mientras la aplicación sigue sin
poder trabajar.

**Decisión 7 — Ni cuerpos de petición ni credenciales en los logs.** `Authorization`,
`Cookie`, `set-cookie` y los campos de contraseña se redactan antes de escribir. El
cuerpo no se registra en absoluto: en este producto lleva descripciones y comentarios
de tickets, que son datos del cliente. Los logs se copian a sitios con muchos menos
controles que la base de datos, así que lo que no está en ellos no se puede filtrar.

**Alternativas descartadas.**
- *OpenTelemetry con trazas distribuidas desde ya.* Es el siguiente paso natural, pero
  exige un collector para aportar algo y aquí todo corre en un proceso. La correlación
  por `requestId` da el 80% del valor —seguir una operación de punta a punta— sin
  infraestructura nueva. Queda como trabajo futuro, y el `request_id` del outbox es la
  costura por la que entrará un `traceparent`.
- *Meter el `requestId` en el payload del evento.* Sin migración, pero contamina el
  contrato de negocio que leen todos los consumidores.
- *Un solo `/health` que lo compruebe todo.* Es lo que había, y convierte cualquier
  caída de dependencia en un bucle de reinicios.
- *Registrar el cuerpo de las peticiones "solo en desarrollo".* Un flag mal puesto un
  día es una fuga de datos de clientes; no registrarlo nunca no tiene ese modo de
  fallo.

**Consecuencias.** (+) Una sola búsqueda por `requestId` reconstruye lo que pasó,
incluidos los efectos asíncronos y los de segunda ola (un evento que produce el propio
worker hereda la correlación). (+) Los workers dicen qué hicieron y cuánto tardaron:
antes solo hablaban al fallar. (+) Las sondas distinguen "está vivo" de "puede
trabajar". (−) Una columna más en el outbox, y **cada columna nueva de esa tabla hay
que concedérsela explícitamente al rol del publicador**, que tiene grants por columna
(ver gotcha). (−) Un log por job procesado: con volumen alto habrá que bajarlo a
`debug`. (−) La correlación depende de que cada consumidor nuevo abra su trabajo con
`runWithJobContext`; no hay nada que lo obligue.

**Revisar si.** Aparece un segundo servicio (→ propagar `traceparent` de W3C en vez de
un id propio, reutilizando la columna), el volumen de logs se dispara (→ muestreo, o
bajar el log por job), o hace falta saber dónde se va el tiempo dentro de una operación
(→ OpenTelemetry de verdad, con spans).

---

## Seguridad (resumen)

Defensa en profundidad: ver ADR-0003 (RLS) y los puntos en `CLAUDE.md`. Items clave:
tenantId solo desde el JWT, rol DB sin BYPASSRLS + FORCE RLS, `set_config`
parametrizado dentro de transacción, jobs/WS re-establecen tenant context, refresh
rotation con reuse detection, argon2id, RBAC por membership, sanitización de email
entrante, verificación de firmas de webhooks, rate limiting en auth, logs sin secretos.
Alcance "portfolio-pragmático": lo crítico implementado, el resto documentado como future work.

---

## ADR-0025 — Directorio de miembros y composición del principal

**Estado:** aceptado · **Fecha:** 2026-09-10

### Contexto

No existía forma de saber quién trabaja en una organización. El frontend no
podía ofrecer un selector de personas para asignar un ticket —`POST
/tickets/:id/assign` pide un UUID que nadie sabe de dónde sacar— y lo resolvía
con un botón "Asignármelo" que cubre al agente pero no al administrador que
reparte trabajo.

Por el mismo hueco, `GET /auth/me` devolvía el principal sin email. Como el
access token vive solo en memoria, al recargar la página el cliente canjea el
refresh, llama a `/auth/me` y se queda sin email hasta el siguiente login.

Las dos cosas son la misma pregunta: **qué identidad se expone por HTTP y a
quién.** Por eso van en un solo ADR.

### Decisión 1 — El directorio vive en `iam` y se llama `GET /members`

`User` y `Membership` son agregados de `iam` (ADR-0011). `ticketing` ya lee
`memberships`, pero detrás del puerto `MemberDirectory` y para una regla suya
("¿este usuario es asignable?"); ese acoplamiento está confinado a un adapter a
propósito, y publicar desde ahí una API de identidad lo convertiría en un
contrato público.

No es `/users` porque lo que se lista son **memberships**: un usuario sin
membership no es miembro de nada, y el `role` no existiría en la respuesta. No
es `/organization/members` porque no hay otra organización direccionable — el
tenant sale del JWT, igual que en `/tickets` y `/sla-policy`.

Se descartó un módulo `directory` propio: sería un bounded context sin
invariantes y con una sola query. Un contexto se justifica por reglas propias,
no por una ruta.

### Decisión 2 — El rango mínimo es AGENT, no VIEWER

Un `VIEWER` es el cliente final: alguien que abrió un ticket. El listado
completo de empleados en sus manos es (a) una lista de correos cosechable para
phishing dirigido, entregada por un endpoint autenticado y por tanto invisible a
cualquier defensa anti-scraping; (b) una radiografía de la plantilla y de su
estructura que ningún cliente necesita; y (c) irreversible, porque lo que se
publica en un contrato de API se queda.

`AGENT` es exactamente el rango que ya puede asignar tickets, así que la
audiencia del endpoint coincide con su propósito sin sobrar nadie. `ADMIN` sería
demasiado estricto: repartir trabajo es la tarea diaria de un agente, el mismo
razonamiento que puso `PATCH /tickets/:id/status` en AGENT.

Es la simétrica de la Decisión 6 del ADR-0020, que dejó la lectura de la
política de SLA en ADMIN aunque leer tickets sea de VIEWER: **el rango se decide
por qué información se revela, no por si el verbo es de lectura.**

**Corolario, y hueco reconocido:** los nombres que un cliente necesita ver en la
conversación de SU ticket no salen de aquí. Saldrán de enriquecer
`GET /tickets/:id` con los participantes de ese ticket —gente con la que el
solicitante ya está hablando— y no de aflojar este endpoint. Sigue pendiente.

### Decisión 3 — Sin paginación y sin filtros

`GET /tickets` pagina por cursor porque los tickets crecen sin techo con el
tiempo; los miembros crecen con la plantilla y están acotados por los asientos
que se facturan. Además el consumidor real —un selector de personas— necesita la
lista entera para poder buscar dentro sin ir y volver al servidor en cada tecla.

La respuesta va envuelta en `{ items }` y no como array pelado: añadir
`nextCursor` mañana es un cambio **aditivo** del OpenAPI (ADR-0004), convertir un
array en objeto rompería a todos los clientes. Cuesta cero hoy.

Un `?role=` se descarta además por engañoso: `role=AGENT` **no** devolvería a los
ADMIN, así que un cliente que filtrara así perdería justo a la gente con más
autoridad — la jerarquía del ADR-0014 no se expresa con igualdad.

**Revisar si** una organización supera unos cientos de miembros: ahí entran
`limit`/`cursor` con el patrón de `TicketReadModel` y, con ellos, la búsqueda por
email. Entran juntos o no entra ninguno: si el conjunto es lo bastante chico para
no paginarlo, también lo es para filtrarlo en el cliente.

### Decisión 4 — Cuatro campos, elegidos uno a uno

`userId`, `email`, `role`, `joinedAt`. El `select` es explícito y el mapeo se
escribe campo a campo, **nunca con un spread de la fila**: `users` guarda
`password_hash` en la misma tabla.

Se llama `userId` y no `id` porque es el valor que referencian `assigneeId`,
`requesterId` y `authorId`; llamarlo `id` invitaría a confundirlo con el id del
membership. Fuera quedan ese id de membership (surrogate interno) y el
`tenantId`, que es el del propio llamante: devolverlo sugeriría que es un
parámetro, y en este sistema el tenant nunca lo es.

### Decisión 5 — El principal se compone del token MÁS una lectura

`GET /auth/me` devuelve el `email` leído de la base de datos y el `role` **del
token**.

Leer el rol fresco haría que `/auth/me` contradijera a los guards, que comparan
contra el rol del token (ADR-0014): la interfaz habilitaría acciones que cada
petición rechazaría con 403 hasta que el token caducase. Un desfase conocido y
coherente es mejor que dos verdades simultáneas.

El email no se mete como claim del JWT: sería PII en una credencial que viaja en
cada cabecera —redactada en *nuestros* logs, no en los de un proxy ajeno—, se
quedaría vieja igual que el rol, y tocaría `AccessTokenClaims`, `SessionIssuer`,
`JwtTokenService`, `TenantContext`, el middleware, el handshake del WebSocket y
todos los e2e que decodifican claims. Mucho blast radius para ahorrar una
consulta por recarga de página.

Un token válido de un usuario que ya no es miembro responde **401**: la sesión no
corresponde a nadie. Un 200 con el email vacío obligaría al cliente a manejar un
estado imposible.

### Decisión 6 — `GET /tickets` acepta `requesterId`

Simétrico a `assigneeId`, y no redundante con él: un VIEWER nunca tiene tickets
asignados, así que "mis tickets" solo significa algo para él si se puede filtrar
por quién los abrió. Sin este filtro, la función existe para unos roles y no para
otros, que es peor que no tenerla.

### Consecuencias

- (+) El frontend puede ofrecer un selector real y, más adelante, gestión de
  roles; la sesión sobrevive a una recarga con el email puesto; y "mis tickets"
  significa algo para los tres roles.
- (+) La superficie expuesta son cuatro campos elegidos uno a uno, y no hace
  falta migración ni índice nuevo: `memberships` ya tiene
  `@@unique([tenantId, userId])`.
- (−) `/auth/me` deja de ser una función pura del token: hace una consulta por
  PK en el camino crítico de carga de la página y puede responder 401.
- (−) El listado etiqueta a las personas por su **email**, porque no hay columna
  `name`. Hasta que la haya, el selector muestra correos.
- (−) Sigue sin existir flujo de invitación: el directorio se puede *leer*, no
  *cambiar*. El seed y los tests insertan sus miembros a mano.

### Deuda que este endpoint destapa

`AutoAssignTicket` reparte solo entre AGENT y ADMIN (`MemberDirectory.agentsOf`),
pero `AssignTicket` manual acepta a **cualquier miembro**: solo comprueba
`isMember`, no el rol. Hoy no se nota porque el frontend solo ofrece
"Asignármelo"; con un selector de personas en pantalla, un administrador puede
asignarle un ticket al cliente que lo abrió. Se decidió **no** endurecer la regla
en esta ronda —es un cambio de negocio con su propio diseño— y mitigarlo
mostrando el rol de cada persona en el selector.

---

## ADR-0026 — Despliegue gestionado: rol dueño propio, Prisma en la imagen y rotación de credenciales

**Contexto.** El primer despliegue es en Railway: Postgres, Redis, la API (con los
workers en el mismo proceso) y el front, cada uno como servicio. Al ensayarlo
aparecieron tres choques entre lo que el código asumía y lo que da una plataforma
gestionada:

1. Las migraciones asumen que el dueño de las tablas se llama **`helpdesk`**
   (`ALTER DEFAULT PRIVILEGES FOR ROLE helpdesk` en la inicial). En local y en CI es
   el superusuario del contenedor; en Railway el superusuario se llama `postgres`,
   y la primera migración fallaría.
2. Las migraciones tienen que correr **antes** de arrancar la API, en el Pre-Deploy
   Command. Pero Railway construye siempre la **última** etapa del Dockerfile, y
   esa imagen no traía el CLI de Prisma (dependencia de desarrollo).
3. La migración inicial crea `helpdesk_app` con la contraseña `'helpdesk_app'`,
   pública en el repo. En Railway, además, el Postgres puede tener un proxy TCP
   público.

### Decisión 1 — Crear el rol `helpdesk` en el despliegue, no cambiar las migraciones

`src/deploy/prepare-database.ts owner` se conecta con el superusuario de la
plataforma (`DATABASE_SUPERUSER_URL`) y crea `helpdesk` (LOGIN SUPERUSER) si no
existe, o solo le fija la contraseña si existe. Las migraciones corren con ese
rol, igual que en local y en CI.

Descartado: reescribir las migraciones para no depender del nombre del dueño.
Son historia aplicada; editarlas cambia su checksum y rompe toda base que ya las
tenga. Y el entorno queda **idéntico** en los tres sitios, que es lo que hace que
el CI pruebe lo mismo que se despliega.

### Decisión 2 — El CLI de Prisma pasa a dependencia de producción

Con eso el Pre-Deploy puede migrar desde la misma imagen que se despliega, y la
secuencia queda **atómica** por despliegue: preparar el dueño → migrar → rotar la
contraseña de la app → seed idempotente → arrancar. Si algo falla, Railway no
arranca la versión nueva.

Descartado: un servicio `migrate` aparte (Railway despliega los servicios en
paralelo y la API podría arrancar contra un esquema viejo), y publicar imágenes
por etapa desde el CI a un registry (lo más prolijo, pero suma registry, tokens y
un paso de CI para un proyecto de una sola instancia).

Costo: la imagen deja de ser mínima (unos 40 MB más con los motores de Prisma).

### Decisión 3 — Rotar la contraseña de `helpdesk_app` en cada despliegue

`prepare-database.ts app` fija la contraseña de `APP_DB_PASSWORD` después de
migrar. `ALTER ROLE ... PASSWORD` no admite parámetros enlazados, así que la
contraseña va dentro del SQL: en vez de escaparla, se **exige** que sea
hexadecimal en minúsculas de 32+ caracteres (`database-roles.ts`), un alfabeto
sin ningún carácter capaz de cerrar el literal. Lo mismo para la del dueño.

El compose de producción para una VPS (`infra/docker-compose.prod.yml`) hace lo
mismo con `psql` y una variable enlazada (`:'pw'`), porque ahí sí hay cliente.

### Consecuencias

- (+) Mismo esquema de roles en local, CI y producción; ensayado contra un
  Postgres con la forma del de Railway (superusuario `postgres`, base `railway`):
  el Pre-Deploy es idempotente y la contraseña pública queda rechazada.
- (+) Rotar cualquiera de las dos contraseñas es cambiar una variable y
  redesplegar.
- (−) El rol dueño es SUPERUSER, como en local. Su credencial solo la usa el
  Pre-Deploy, nunca la API, que sigue con el rol restringido sin BYPASSRLS
  (ADR-0010).
- (−) La imagen de producción carga con el CLI de Prisma.

**Adenda (2026-11-07) — Postgres gestionado SIN superusuario (Neon) y despliegue gratis.**
El despliegue preferido pasa a ser gratis: Vercel (front), Render Free (API con
los workers en el mismo proceso), Render Key Value (Redis) y Neon (Postgres).
Neon no da SUPERUSER: su rol más alto tiene CREATEROLE. Ensayado contra un
Postgres 17 local con esa forma (dueño `helpdesk` con CREATEROLE y CREATEDB,
nada más), aparecieron tres cosas:

1. `CREATE ROLE helpdesk ... SUPERUSER` falla ("Only roles with the SUPERUSER
   attribute may create roles with the SUPERUSER attribute"). Esperado.
2. **Peor: si `helpdesk` ya existe, el paso `owner` NO falla.** Cae en la rama
   `ALTER ROLE helpdesk PASSWORD` (cambiarse la propia contraseña está
   permitido) y pisa en silencio la contraseña que dio la consola.
3. **La segunda migración falla** con `42501 permission denied for schema
   public`. Sin superusuario, `ALTER FUNCTION ... OWNER TO x` exige que `x`
   tenga CREATE en el esquema de la función, y los roles dueños de las
   funciones `SECURITY DEFINER` (ADR-0012, 0019, 0021) solo tienen USAGE. Un
   superusuario se salta ese chequeo: por eso local y CI nunca lo vieron.

**Decisión.** `DATABASE_OWNER_MODE=create|external` en `prepare-database.ts`
(`create` por defecto, lo de siempre):
- `external`: `helpdesk` se crea a mano en la consola del proveedor. `owner`
  solo comprueba que `MIGRATION_DATABASE_URL` entre como `helpdesk` con
  CREATEROLE, y crea los tres roles NOLOGIN (idénticos a como los crean las
  migraciones, que los saltan si existen) con **CREATE temporal en `public`**.
  `app` corre con la misma conexión —desde Postgres 16 el creador de un rol
  tiene ADMIN OPTION sobre él— y retira ese CREATE.
- `create` ahora exige que la conexión sea SUPERUSER de verdad antes de tocar
  nada, y si no lo es sugiere `external`. Cierra el punto 2.
- Paso nuevo `verify`, para los dos modos: falla si `helpdesk_app` es SUPERUSER
  o tiene BYPASSRLS, si alguna tabla no tiene RLS con FORCE o es de
  `helpdesk_app`, o si algún rol conserva CREATE en `public`. En un Postgres
  gestionado no se puede dar por hecho que los roles salgan como en local.
- Render Free no tiene Pre-Deploy: la secuencia `owner → migrate deploy → app →
  verify` se corre desde la PC contra la conexión **directa** de Neon (no la del
  pooler). Detalle en `docs/DEPLOY.md`.

**Alternativas descartadas.**
- *Editar las migraciones* para que no cambien dueños o den el GRANT ellas: son
  historia aplicada (cambia el checksum, Decisión 1).
- *Dar CREATE en `public` a esos roles para siempre*: es más privilegio del que
  necesitan; solo hace falta en el instante del `ALTER ... OWNER`.
- *Pooler de Neon para la API*: `set_config(..., true)` es transaccional y
  funcionaría en modo transacción, pero Prisma pediría `pgbouncer=true` y no se
  ensayó. Directa, que es lo probado.

**Memoria (la duda que bloqueaba Render Free, 512 MB).** Imagen de producción
con `--memory=512m`, API + workers en un proceso, 25 WebSockets y ~900
peticiones: pico de RSS 216 MiB, estable en ~160 MB. Entra. Se fija igual
`NODE_OPTIONS=--max-old-space-size=256` en `render.yaml`. Lo que aprieta es la
CPU: con 0.1 CPU el arranque en frío tardó 77 s y un login 0.6–1.6 s.

**Consecuencias.**
- (+) El mismo código y las mismas migraciones sirven con y sin superusuario;
  ensayado de punta a punta dos veces seguidas (idempotente): 7 migraciones, 12
  tablas con RLS + FORCE, `helpdesk_app` sin BYPASSRLS, funciones `SECURITY
  DEFINER` de sus roles, contraseña pública rechazada. Contra esa misma base, con
  la app entrando como `helpdesk_app`: seed OK y 75/75 e2e de RLS, auth,
  tickets, outbox, colas y SLA (el de SLA necesitó `--testTimeout=180000` por el
  disco lento de la PC; con 30 s caían los `beforeAll`, sin errores de permisos).
- (+) `verify` convierte el ADR-0010 en una comprobación ejecutable del
  despliegue, no solo de los e2e.
- (−) Las migraciones en producción son un paso manual desde la PC: hay que
  correrlas antes de que se despliegue el código que las necesita.
- (−) Render Free duerme sin tráfico y con él los workers (los eventos esperan
  en el outbox y los vencimientos en `sla_timers`), y el Key Value Free no
  persiste: un reinicio pierde los jobs en cola. Aceptable para una demo.


## ADR-0027 — Triage con IA: servicio externo sin estado, y la IA sugiere, no decide

**Estado:** aceptado (2026-11-09). Primera fase de la capa de IA: clasificación.
La respuesta sugerida con RAG queda para una fase posterior.

### Contexto

Un agente abre cada ticket nuevo sin contexto: tiene que leerlo para saber de
qué va y cuán urgente es de verdad. Un modelo de lenguaje puede adelantar ese
trabajo —categoría, prioridad sugerida, tono del cliente, idioma— en cuanto el
ticket entra. Pero meter un LLM en el sistema abre tres problemas que este ADR
resuelve de forma explícita:

1. **El texto del ticket es input no confiable.** Lo escribe el cliente, y un
   LLM puede ser manipulado por instrucciones escondidas en ese texto (prompt
   injection).
2. **El modelo se equivoca**, y de forma no determinista. Las evals del servicio
   (`helpdesk-ai/evals`) lo cuantifican: con un modelo local de 3B, la categoría
   acierta el 63% y la prioridad exacta el 36% (95% a un paso o menos).
3. **Es lento y puede no estar.** En CPU tarda ~3 s por ticket y ~90 s en el
   primero tras arrancar; un proveedor externo puede caerse o limitar.

### Decisión 1 — Servicio Python aparte, sin base de datos ni tenant

`helpdesk-ai` es un repo propio (coherente con el ADR-0001) en Python/FastAPI,
donde vive el ecosistema de IA. Es **sin estado**: recibe asunto y descripción y
devuelve un JSON validado. No conoce ids, ni tenants, ni tiene credenciales de
Postgres.

Es la defensa principal contra el prompt injection: lo peor que consigue un
ticket malicioso es una etiqueta equivocada, porque al otro lado no hay nada que
leer ni que escribir. Las capas del prompt (texto delimitado, etiquetas de
cierre neutralizadas, salida restringida a enums) reducen la probabilidad; esta
decisión acota el daño.

Alternativas descartadas:
- *Python consume de BullMQ directamente*: acopla un segundo lenguaje al formato
  interno de los jobs en Redis.
- *Python escribe en Postgres*: necesitaría un rol con acceso a datos de todos
  los tenants, justo lo que el ADR-0010 evita.

### Decisión 2 — Un consumidor más del outbox, con la llamada FUERA de la transacción

`ticket.created` va también a la cola `ai-triage`. El consumidor
(`AiTriageProcessor` → `TriageTicket`) trabaja en tres pasos:

1. Comprobaciones baratas sin transacción (¿existe el ticket?, ¿ya tiene
   triage?), para no pagar una llamada al modelo en vano.
2. La llamada HTTP al servicio, **sin transacción abierta**: con un modelo lento,
   una transacción que lo espere retiene una conexión del pool por cada ticket
   en curso.
3. Una transacción corta: marca en `processed_messages`, sugerencia, auditoría
   (`ticket.triaged`, actor sistema) y evento `ticket.triaged` al outbox.

El precio: dos entregas simultáneas del mismo evento pagan dos llamadas y solo
una guarda. Es raro y acotado; a cambio, la base de datos nunca espera a la IA.

`lockDuration` del worker en 180 s: con el valor por defecto de BullMQ (30 s),
un job que espera al modelo se daría por colgado y se entregaría a otro worker
mientras el primero sigue esperando — dos llamadas por el mismo ticket.

### Decisión 3 — La IA sugiere, no decide

La sugerencia vive en su propia tabla, `ticket_triages` (una fila por ticket,
RLS como el resto), y **no modifica el ticket**. Si la prioridad sugerida se
escribiera en `tickets.priority`, una salida del modelo cambiaría los relojes de
SLA sin que nadie la aceptara. La prioridad real solo la cambia una persona.

Se guardan `model` y `prompt_version`: es lo que permitirá medir con datos
reales cuánto acierta cada versión contra lo que el agente terminó eligiendo.

### Decisión 4 — Errores: transitorio reintenta, permanente a la DLQ

El adapter (`HttpTicketClassifier`) traduce el contrato HTTP del servicio:

| Respuesta | Error | Qué hace la cola |
|---|---|---|
| red caída, timeout, 429, 5xx (salvo 502) | `TriageUnavailableError` | reintenta con backoff |
| 4xx, 502, o respuesta que no valida | `TriageRejectedError` | DLQ (`dlq-ai-<eventId>`) |

La respuesta se **revalida** contra los valores del dominio aunque el servicio
ya valide la suya: es un sistema externo, y lo que entra en nuestra base lo
decide esta frontera.

### Decisión 5 — Solo el equipo ve la sugerencia

`GET /tickets/:id/triage` exige AGENT (regla del ADR-0025: el rango se decide
por lo que se revela). Incluye el sentimiento que la IA atribuye al cliente, y
el cliente es el VIEWER. Por el mismo motivo `ticket.triaged` va solo a la sala
`staff` del WebSocket. La vista no expone tokens ni latencia: eso es telemetría.

### Decisión 6 — La IA es opcional

Sin `AI_SERVICE_URL`, el consumidor descarta los eventos como `disabled` (no se
acumulan en Redis) y el endpoint responde `pending`. El sistema arranca y
funciona igual. Entre servicios autentica un secreto compartido
(`AI_SERVICE_TOKEN` → cabecera `X-Internal-Token`).

### Consecuencias

- (+) El aislamiento entre tenants no depende del comportamiento del modelo.
- (+) Cambiar de modelo o de proveedor (Ollama local ↔ API de Anthropic) es una
  variable de entorno del servicio, y las evals comparan ambos con el mismo
  dataset.
- (+) Un fallo de la IA nunca bloquea crear, asignar o atender un ticket.
- (−) Un servicio más que desplegar y vigilar.
- (−) La lista de categorías está duplicada (dominio TS y `schema.py`). Es
  deliberado —cada lado decide qué acepta—: si divergen, el adapter rechaza la
  categoría desconocida y el job va a la DLQ, en vez de guardarla en silencio.
- (−) Con el modelo de 3B, el prompt injection consigue subir la prioridad
  sugerida (0/6 en ese subconjunto de las evals). Como la sugerencia no se
  aplica sola, el efecto es una etiqueta engañosa para el agente; mejorarlo es
  trabajo de prompt y de modelo, medible con las evals.

## ADR-0028 — Notas internas: visibilidad del comentario, SLA y sala del equipo

**Estado:** aceptado (2026-11-11). Primera funcionalidad de la "tanda 1" de
producto, tras comparar con Zendesk, Freshdesk, Help Scout y Zammad: todos
tienen notas que el cliente no ve, y el resto de la tanda (portal del cliente,
email) no se puede abrir sin ellas.

### Contexto

Hasta ahora todo comentario era conversación con el cliente. El equipo no tenía
dónde coordinarse ("parece el bug de la 4.2.0, lo escalo") sin que lo leyera el
solicitante, que en el modelo de roles es el VIEWER (ADR-0014, ADR-0025).

Sumarlo como "una columna más" tenía un hueco serio: el SLA de primera respuesta
se para con el primer comentario de un AGENT o ADMIN (ADR-0020). Una nota
interna lo habría parado, y el SLA se daría por cumplido sin que el cliente
recibiera una sola palabra.

### Decisión 1 — Visibilidad en el comentario, no una tabla aparte

`comments.visibility` (`PUBLIC` | `INTERNAL`, `PUBLIC` por defecto). La migración
deja todos los comentarios existentes como `PUBLIC`, que es lo que eran. Es la
misma conversación, en el mismo orden, con la misma inmutabilidad: dos tablas
obligarían a mezclar dos listas para mostrar un hilo.

La visibilidad es **inmutable** como el resto del comentario: una nota no se
"publica" después. Si se pudiera, lo que vio el cliente y lo que cuenta la
auditoría dejarían de coincidir.

### Decisión 2 — Solo el equipo escribe notas, y lo decide el dominio

`Comment.write` recibe el rol del autor (del JWT verificado, nunca del body) y
devuelve `InternalNoteForbiddenError` (403) si un VIEWER intenta una nota. El
"equipo" es la misma pregunta que ya se hacía el SLA, `isResponder` (AGENT y
ADMIN), expuesta como `isStaff`: si un rol pudiera leer notas pero su comentario
no contara como respuesta, o al revés, las dos reglas acabarían
contradiciéndose.

### Decisión 3 — La lectura filtra en el WHERE, no en memoria

`TicketReadModel.detail` recibe el rol de quien mira y filtra con
`visibility IN (visibleTo(role))`. Una nota que el cliente no puede ver ni
siquiera sale de la base. El historial de auditoría no necesita filtro: ya es
solo para AGENT.

**No hay RLS por rol, y es deliberado.** Las policies filtran por tenant, no por
rol. Sumar `app.current_role` a la transacción y una policy sobre `comments`
daría defensa en profundidad, pero toca el `TransactionManager` y todos los
roles de base de datos, y es exactamente el trabajo que trae el rol CLIENTE del
portal (donde además hay que filtrar "solo sus tickets"). Entra ahí. Hasta
entonces, la garantía la dan este WHERE y su e2e.

### Decisión 4 — `comment.added` v3, y v2 se lee como público

El evento suma `visibility`. El consumidor del SLA usa la regla de dominio
`countsAsResponse({ authorRole, visibility })`: cuenta solo lo que escribe el
equipo **y** ve el cliente. Una nota interna se ignora con `detail: 'nota
interna'`.

Un v2 en vuelo no se descarta: se lee como `PUBLIC`. No es una suposición, es lo
que pasó: antes de este ADR todos los comentarios lo eran. Es la diferencia con
el v1 del ADR-0020, que se descartaba porque le faltaba un dato imposible de
deducir. Un valor de visibilidad desconocido, en cambio, no se adivina: fallo
permanente, a la DLQ.

### Decisión 5 — El aviso de una nota va a la sala del equipo

`BroadcastTicketEvent` manda el `comment.added` de una nota a `staff`, no a la
sala del ticket. El aviso no lleva el cuerpo (ADR-0023), pero en la sala del
ticket está el cliente que lo tiene abierto: sabría que el equipo escribió algo,
y cuándo. Es la regla del ADR-0022, "el filtrado por rol es una sala, no un
`if`". Falla cerrado: un v2 sin el campo va al ticket (era público), un valor
desconocido va al equipo. El cliente web no cambia: invalida el detalle por
`ticketId`, venga de la sala que venga.

### Consecuencias

- (+) El equipo coordina dentro del ticket sin abrir otro canal.
- (+) El SLA sigue midiendo lo que promete: cuánto tarda el cliente en recibir
  una respuesta.
- (+) Prepara el portal del cliente y el canal de email: lo que se le manda al
  cliente es exactamente lo `PUBLIC`.
- (−) La confidencialidad de las notas depende de la aplicación, no de la base,
  hasta que entre el RLS por rol.
- (−) El contrato del WebSocket y los tipos del frontend se siguen manteniendo a
  mano (deuda conocida del ADR-0004): `visibility` se agregó en los dos lados.

---

## ADR-0029 — Pausa del SLA: reloj pausable, vencimiento corrido y pausa en la transacción del cambio

**Estado:** aceptado (2026-11-12). Segunda pieza de la "tanda 1" de producto:
el estado "esperando al cliente" de Zendesk, Freshdesk y Zammad. Diseño en
`docs/superpowers/specs/2026-11-12-esperando-al-cliente-design.md`.

### Contexto

Cuando un agente necesita algo del solicitante (un dato, una captura, que pruebe
algo), el ticket seguía en `IN_PROGRESS` y el reloj de resolución seguía
corriendo: el SLA penalizaba al equipo por un tiempo que depende del cliente, y
el agente no tenía forma de decir "la pelota está del otro lado".

Lo difícil no es el estado sino el reloj. `due_at` se calculaba una vez y era
inmutable (ADR-0020, decisión 4), y lo lee un barrido que marca incumplimientos
irreversibles (ADR-0021). Pausar sin tocar `due_at`, o sin que el barrido se
entere, convierte la pausa en un incumplimiento seguro.

### Decisión 1 — Estado `WAITING_ON_CUSTOMER`

Se entra solo desde `IN_PROGRESS` (alguien trabaja el ticket) y se sale a
`IN_PROGRESS` o a `RESOLVED`. No a `OPEN` ni a `CLOSED`. Ver la adenda del
ADR-0015.

### Decisión 2 — Vuelve solo cuando contesta el cliente, y lo decide el agregado

Un comentario **público** de alguien que **no es del equipo**
(`!isResponder(authorRole)`, la misma frontera que `countsAsResponse`) sobre un
ticket en espera lo devuelve a `IN_PROGRESS`. Lo decide `Ticket.registerComment`
llamando a `changeStatus`, así que se emite el `ticket.status_changed` normal y
nadie aguas abajo necesita una regla propia para comentarios. Una nota interna o
un comentario del equipo no lo sacan.

El cambio lo audita `AddComment` como **sistema** (`SYSTEM_ACTOR_ID`,
`automatic: true`, `trigger: 'customer_reply'`, `commentId`): nadie lo pidió, es
una consecuencia. El autor queda en la entrada del comentario.

### Decisión 3 — El reloj es pausable y el vencimiento se corre

`sla_timers.paused_at`. El estado sigue **derivado** de fechas, ahora con cuatro
valores: corriendo, **en pausa**, cumplido, incumplido. Al reanudar,
`due_at = calendario.dueAt(ahora, calendario.workingMinutesBetween(paused_at, due_at))`:
el margen se mide en el CALENDARIO y no restando fechas, para que el horario
laboral no obligue a reescribir la pausa. Parar un reloj pausado (resolver desde
la espera) lo reanuda primero, así que el margen descuenta la pausa. La vista
mide el margen de un reloj pausado contra `paused_at`: queda congelado.

Solo se pausa el reloj de **resolución**. El de respuesta casi siempre está
parado (para pedirle algo al cliente hubo que responderle), y si no lo está,
sigue corriendo: pedir algo es responder.

`sla_due_timers` filtra `paused_at IS NULL`, y el rol del barrido recibe
`GRANT SELECT (paused_at)`: sus privilegios son por columna y no alcanzan a las
columnas nuevas (el mismo fallo que dejó sin drenar el outbox en la fase 8).

### Decisión 4 — Pausar y reanudar van en la transacción del cambio de estado

`SlaPauseCoordinator`, llamado por `ChangeTicketStatus` y `AddComment` dentro de
su transacción, con el mismo `now`. **Es la única excepción** al patrón "los
relojes los mueve el consumidor del outbox": arrancar y parar siguen en
diferido.

La razón: arrancar y parar toleran retraso (se fechan con `occurredAt` y nadie
decide nada con el reloj mientras tanto). Pausar no, porque el barrido usa ese
dato para decidir un incumplimiento irreversible.

Como el arranque sigue siendo diferido, un ticket puede llegar a la espera
**antes** de tener relojes (worker atrasado; el seed, siempre). Por eso
`StartSlaTimers` mira el estado actual del ticket y, si ya espera al cliente,
el reloj de resolución nace pausado desde `updatedAt` (aproximación que, si
falla, cuenta de más contra el equipo, nunca de menos). Y un reloj ya vencido
que el barrido aún no marcó **no se pausa**: pausarlo le borraría el retraso.
Los dos huecos los encontró la revisión final de la rama.

### Decisión 5 — Las transiciones del reloj son escrituras condicionadas

`SlaTimerRepository.transition(timer, expected)` hace un `UPDATE ... WHERE`
condicionado al estado en que se leyó la fila (`running` o `paused`) y devuelve
si escribió. `save` queda solo para el alta. Antes, parar e incumplir usaban un
upsert sin condición, y una pausa y el barrido simultáneos se pisaban. Si
`transition` pierde, el caso de uso no actúa como si su cambio hubiera ocurrido
(el barrido no audita ni publica un incumplimiento que no se escribió). Ver la
adenda del ADR-0021.

### Alternativas descartadas

- *Pausa en diferido, reconciliando contra el estado actual del ticket.* Pausar
  "si el ticket sigue en espera" y reanudar "si ya no lo está". Falla con espera
  → retomar → espera antes de que el worker procese: la primera pausa se aplica,
  la reanudación se salta (el ticket vuelve a estar en espera) y la segunda pausa
  no hace nada. El tramo trabajado cuenta como pausa: el error favorece al
  equipo, justo al revés de lo que promete un SLA. Además, una pausa procesada
  tarde llegaba después de que el barrido marcara el incumplimiento.
- *Pausa en diferido, blindada.* Columnas extra para saber qué transición se
  aplicó la última y un `MarkSlaBreached` que consulta el ticket. Mantiene un
  único patrón, pero con más piezas, más casos borde y alguna carrera que sigue
  abierta.
- *Pausar también el reloj de respuesta.* Abriría la puerta a "pausar" un ticket
  sin haberle contestado al cliente.
- *Que la IA decida la pausa.* El SLA es un compromiso con el cliente; no puede
  depender de un modelo que se equivoca. La IA podrá **sugerir** pasar a la
  espera (ROADMAP §2), nunca hacerlo.

### Consecuencias

- (+) El SLA deja de penalizar el tiempo que depende del cliente, y el agente
  puede decirlo con un estado en vez de con una nota.
- (+) La pausa no tiene carreras con el barrido ni con el orden de los eventos.
- (+) `transition` cumple de verdad la "idempotencia por condición" que el
  ADR-0021 prometía al leer y no cumplía al escribir.
- (+) La costura del horario laboral (`workingMinutesBetween`) queda puesta.
- (−) Dos patrones para mover relojes: el síncrono (pausa) y el diferido
  (arrancar, parar, incumplir). Está acotado y explicado aquí.
- (−) `due_at` ya no guarda el objetivo original. Se reconstruye desde el
  AuditLog (las transiciones a y desde la espera quedan fechadas); si los
  reportes de la tanda 3 lo necesitan seguido, se añadirá la columna entonces.
- (−) Carrera aceptada: si el barrido incumple en el mismo instante en que el
  agente pausa, gana quien escribe primero. Si gana el barrido es porque el
  reloj de verdad había vencido antes de la pausa.
- (−) Un ticket en espera queda así sin límite: el auto-resolver a los N días
  llega con las automatizaciones de la tanda 3.

**Revisar si.** Llega el horario laboral (→ comprobar que la reanudación usa el
calendario del reloj y no uno global), o aparecen más estados que pausan el SLA
(p. ej. "esperando a un tercero") → la regla del coordinador pasaría a ser una
propiedad del estado en la tabla del ADR-0015.

---

## ADR-0030 — Respuestas predefinidas: solo texto, variables cerradas y relleno en el cliente

**Estado:** aceptado (2026-11-12). Tercera pieza de la "tanda 1" de producto.
Diseño en `docs/superpowers/specs/2026-11-12-respuestas-predefinidas-design.md`.

### Contexto

El agente escribe muchas veces por día lo mismo ("Gracias, lo estamos
revisando", "¿Nos pasás una captura?"). Zendesk, Freshdesk, Help Scout y Zammad
lo resuelven con plantillas; aquí no existían.

### Decisión 1 — Solo texto, no "macros"

Insertar una respuesta no cambia estado, prioridad ni asignación. Las macros de
Zendesk sí lo hacen, pero eso es un motor de reglas con efectos sobre el
agregado `Ticket` (tanda 3, automatización), y mezclarlo aquí haría que una
plantilla de texto tuviera que pasar por la máquina de estados del ADR-0015.

### Decisión 2 — Compartidas por organización; leer pide AGENT

Las crea, edita y borra el ADMIN; el AGENT las lista y usa. **El VIEWER no las
ve (403)**: cuentan cómo trabaja el equipo por dentro, y el VIEWER es el cliente
final. Es la regla del ADR-0025 aplicada otra vez: el rango se decide por lo que
se revela, no por si el verbo es de lectura. Plantillas personales quedan fuera;
sumarlas sería una columna `owner_id` nullable, aditiva.

### Decisión 3 — Variables cerradas, validadas al guardar

Cuatro: `{{ticket.numero}}`, `{{ticket.asunto}}`, `{{cliente.email}}`,
`{{agente.email}}` (sensibles a mayúsculas, espacio interno tolerado). El cuerpo
es válido solo si, tras quitar las válidas, no queda ningún `{{` ni `}}`; así
una variable mal escrita, una llave sin cerrar, `{{}}` o `{{{x}}}` son un 400
que nombra el fragmento. El fallo que se evita es concreto: una variable que
nadie rellena le llega literal al cliente.

### Decisión 4 — El relleno es del CLIENTE, no del servidor

El backend guarda y valida plantillas; el front las rellena al insertarlas y el
agente puede editar el resultado antes de mandarlo, que sale como un
`POST /tickets/:id/comments` normal. Se descartó que el servidor enviara la
plantilla directamente: el agente no podría ajustarla, y "mandar sin ver" es
justo lo que no se quiere. **Coste aceptado:** el sistema no sabe qué plantilla
originó un comentario, así que no hay métricas de uso. Si hicieran falta, sería
un `canned_response_id` opcional en el comentario.

La regla de variables vive DOS veces —dominio del api y `fill.ts` del web—
porque son repos separados (ADR-0001). Las dos tienen tests con los mismos
casos.

### Decisión 5 — Unicidad del título con una columna normalizada

"Saludo" y " saludo " no pueden convivir: confunden al elegir. Se guarda
`title_key` (recortado y en minúsculas, lo calcula el dominio) con
`@@unique([tenant_id, title_key])`. Se descartó un índice único sobre
`lower(title)`: Prisma no modela índices de expresión y `migrate diff` marcaría
drift para siempre. La comprobación del caso de uso da el error claro; la
restricción de la base cubre la carrera entre dos ADMIN, y el borde traduce su
`P2002` al mismo 409.

### Decisión 6 — Borrado físico, auditado con el contenido

Ningún comentario apunta a una plantilla (Decisión 4), así que borrarla no deja
nada colgando. `canned_response.created|updated|deleted` se auditan en la misma
transacción (ADR-0016); el borrado guarda título y cuerpo, y la edición el antes
y el después. Sin evento de outbox ni realtime: ningún consumidor necesita
enterarse.

### Consecuencias

- Tabla `canned_responses` con RLS como todo lo demás (migración
  `20261112130000_canned_responses`). Sin roles nuevos.
- Endpoints `GET|POST /canned-responses`, `PUT|DELETE /canned-responses/:id`.
- La sesión del web vuelve a leer el email de `/auth/me` al restaurarse: sin él,
  `{{agente.email}}` quedaba sin rellenar tras cada recarga.

- `created_by` NO tiene FK a `users`, a propósito: es un dato de autoría,
  como `audit_logs.actor_id`, y si mañana se borra un usuario la plantilla
  tiene que seguir existiendo y diciendo quién la creó. Una FK obligaría a
  elegir entre borrar la plantilla en cascada o dejar la columna en `NULL`.

**Revisar si.** Se piden métricas de uso (→ id opcional en el comentario), o
llegan las automatizaciones (→ una "macro" sería una regla que además inserta
una plantilla, no una plantilla con efectos).

---

## ADR-0031 — Etiquetas: catálogo por organización, clasificación interna y fuera del agregado

**Estado:** aceptado (2026-11-12). Entrega 1 de 3 de "etiquetas + búsqueda +
vistas guardadas" (tanda 1). Diseño en
`docs/superpowers/specs/2026-11-12-etiquetas-design.md`.

### Contexto

El equipo necesita clasificar tickets con criterios propios ("facturación",
"bug", "vip") para encontrarlos y repartirlos, y las vistas guardadas
(ADR-0033) van a filtrar por eso.

### Decisión 1 — Catálogo + tabla de relación, no texto libre

`tags` (por organización) y `ticket_tags`. Zendesk usa texto libre por ticket;
es más simple, pero renombrar obliga a reescribir miles de filas y los typos
("factura" / "facturas") se multiplican. Con catálogo, renombrar es una fila y
el color vive en un solo sitio. `ticket_tags` lleva `tenant_id` propio para
que su policy de RLS sea idéntica a la del resto del esquema.

### Decisión 2 — El agente crea al vuelo; el ADMIN administra

`GET`/`POST /tags` y `PUT /tickets/:id/tags` piden AGENT: pedirle a un ADMIN
que cree la etiqueta antes de usarla frena al agente en pleno trabajo.
Renombrar, recolorear y borrar piden ADMIN, porque afectan a todos los
tickets que la usan.

### Decisión 3 — Clasificación INTERNA: el cliente no la ve

Para un VIEWER la clave `tags` no existe en ninguna respuesta (se omite, no
`[]`, para no insinuar nada), el read model ni siquiera la lee, el aviso en
vivo va solo a la sala `staff` y filtrar por `tagId` le da 403. Es el mismo
criterio que la sugerencia de la IA (ADR-0027).

### Decisión 4 — Fuera del agregado `Ticket`; reglas en una función pura

Las etiquetas no son estado del agregado: cargar un ticket no carga sus
etiquetas, y cambiarlas pasa por `TicketTagRepository`. Las reglas del
conjunto (deduplicar, máximo 10, qué se añadió y qué se quitó) viven en
`diffTagSets`, una función pura del dominio, y no repartidas en el caso de
uso. Etiquetar SÍ es actividad sobre el ticket: `Ticket.recordTagsChanged`
actualiza `updatedAt` y emite `ticket.tags_changed` desde la raíz, como todos
los eventos (ADR-0018). Un `PUT` sin cambios no audita ni emite.

### Decisión 5 — Nombre único sin mayúsculas, paleta cerrada de colores

`name_key` (recortado y en minúsculas) con `@@unique([tenant_id, name_key])`,
el mismo patrón que `title_key` del ADR-0030. Ocho colores con nombre
(`gray`…`purple`), no hex libre: con nombres, el front elige el tono legible
en cada tema.

### Decisión 6 — Historial con nombres; filtro tolerante

La auditoría `ticket.tags_changed` guarda `{added, removed}` con id Y nombre,
así el historial se lee aunque la etiqueta se renombre o se borre después.
`GET /tickets?tagId=a&tagId=b` trae los tickets con al menos una, y un id que
no existe simplemente no coincide (200): una vista guardada que apunta a una
etiqueta borrada no queda rota.

### Consecuencias

- Migración `20261112140000_tags` (RLS en las dos tablas). Borrar una
  etiqueta la quita de sus tickets por cascada, sin un evento por ticket (sería
  una tormenta): el front invalida su caché al borrar.
- Concurrencia: `SetTicketTags` lee el ticket con `findByIdForUpdate`
  (`SELECT ... FOR UPDATE`). El spec decía "gana el último, sin bloquear",
  pero la revisión final encontró dos fallos de no bloquear: dos `PUT` a la
  vez que comparten una etiqueta chocaban en la PK de `ticket_tags` (500), y
  como el caso de uso guarda el ticket ENTERO, etiquetar mientras otro lo
  cerraba lo reabría en silencio. Con el bloqueo sigue ganando el último, pero
  el segundo espera y calcula su diff sobre lo que dejó el primero. Hay un e2e
  con seis `PUT` simultáneos. `AddComment` tiene el mismo patrón de leer y
  guardar entero sin bloquear: anotado, no tocado en esta entrega.

**Revisar si.** Llegan las reglas de automatización (etiquetar solo, tanda 3),
o se piden etiquetas visibles para el cliente (→ una columna `public` en el
catálogo, no una regla en el front).
