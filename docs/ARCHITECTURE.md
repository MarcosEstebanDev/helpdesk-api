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
junto (pendiente: depende de la topología de despliegue).
**Revisar si.** Se despliega más de una instancia (→ mover el almacenamiento a Redis,
ya disponible desde la fase 5), o si el bloqueo del usuario legítimo resulta un
problema real (→ limitar por cuenta además de por IP).


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

## Seguridad (resumen)

Defensa en profundidad: ver ADR-0003 (RLS) y los puntos en `CLAUDE.md`. Items clave:
tenantId solo desde el JWT, rol DB sin BYPASSRLS + FORCE RLS, `set_config`
parametrizado dentro de transacción, jobs/WS re-establecen tenant context, refresh
rotation con reuse detection, argon2id, RBAC por membership, sanitización de email
entrante, verificación de firmas de webhooks, rate limiting en auth, logs sin secretos.
Alcance "portfolio-pragmático": lo crítico implementado, el resto documentado como future work.
