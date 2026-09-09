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

**Decisión 5 — El calendario es una interfaz, hoy con una sola implementación.** Los
minutos se cuentan sobre `SlaCalendar`; existe `CALENDAR_24_7` y nada más. La interfaz
no es especulación: es la costura por la que entrará el horario laboral por tenant con
su zona horaria. Aislar hoy lo que sabemos que va a cambiar cuesta una interfaz; no
aislarlo cuesta reescribir cada sitio donde se sumó tiempo a mano.

**Alternativas descartadas.**
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
funcionando si no configura nada. (+) El cálculo del vencimiento es una función pura,
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

---

## Seguridad (resumen)

Defensa en profundidad: ver ADR-0003 (RLS) y los puntos en `CLAUDE.md`. Items clave:
tenantId solo desde el JWT, rol DB sin BYPASSRLS + FORCE RLS, `set_config`
parametrizado dentro de transacción, jobs/WS re-establecen tenant context, refresh
rotation con reuse detection, argon2id, RBAC por membership, sanitización de email
entrante, verificación de firmas de webhooks, rate limiting en auth, logs sin secretos.
Alcance "portfolio-pragmático": lo crítico implementado, el resto documentado como future work.
