# Despliegue

Tres caminos, con el mismo esquema de roles de base de datos (ADR-0026):

- **Gratis: Vercel + Render + Neon** (el preferido desde 2026-11-07): front en
  Vercel, API con los workers en Render Free, Postgres en Neon, Redis en Render
  Key Value. Migraciones desde la PC. Ver la sección
  [Despliegue gratis](#despliegue-gratis-vercel--render--neon).
- **Railway**: un servicio por pieza, migraciones en el Pre-Deploy. Plan Hobby,
  5 USD/mes. Queda como plan B si el gratis se queda corto.
- **Una VPS con Docker** (`infra/docker-compose.prod.yml`): todo en una máquina,
  con Caddy y HTTPS automático. Sirve para Oracle Cloud Always Free, Hetzner, etc.

## La restricción que manda: un solo sitio

La cookie del refresh es `SameSite=Lax` (ADR-0011). El navegador solo la manda si
el front y la API son el **mismo sitio**: `app.midominio` y `api.midominio`
sirven, dos dominios de plataforma no. `up.railway.app`, `vercel.app` y
`duckdns.org` están en la Public Suffix List, así que
`web-x.up.railway.app` y `api-x.up.railway.app` son sitios DISTINTOS: el login
funciona, pero cada recarga cierra la sesión.

Por eso hace falta un dominio propio con dos subdominios. Gratis:
[is-a.dev](https://docs.is-a.dev) (acepta CNAME y TXT, que es lo que pide Railway).
`is-a.dev` también está en la PSL, y eso es justo lo que sirve: el sitio pasa a
ser `<nombre>.is-a.dev`, así que `app.<nombre>.is-a.dev` y
`api.<nombre>.is-a.dev` son el MISMO sitio.

## Despliegue gratis (Vercel + Render + Neon)

| Pieza | Dónde | Plan | Archivo |
|---|---|---|---|
| Front (Next.js) | Vercel, `app.<nombre>.is-a.dev` | Hobby | `helpdesk-web/package.json` (`packageManager`, `engines`) |
| API + workers (un proceso) | Render, `api.<nombre>.is-a.dev` | Free (512 MB, 0.1 CPU) | `render.yaml` |
| Redis (BullMQ + adapter de Socket.io) | Render Key Value | Free (25 MB) | `render.yaml` |
| Postgres 17 | Neon | Free | — (roles a mano, abajo) |

### Lo que cambia respecto de Railway, y por qué

- **Neon no da SUPERUSER.** El rol más alto tiene CREATEROLE, así que
  `CREATE ROLE helpdesk ... SUPERUSER` falla. `helpdesk` se crea en la consola y
  los pasos de base de datos corren con `DATABASE_OWNER_MODE=external` (adenda del
  ADR-0026). Ese modo, además, da CREATE temporal en `public` a los tres roles
  dueños de funciones `SECURITY DEFINER` mientras se migra: sin superusuario,
  `ALTER FUNCTION ... OWNER TO` lo exige y la segunda migración fallaba con
  `permission denied for schema public`.
- **Render Free no tiene Pre-Deploy** (ni Background Workers). Las migraciones se
  corren **desde la PC**, contra la conexión **directa** de Neon, y los workers
  van dentro del proceso de la API (`WORKER_ENABLED=1`, como en Railway).
- **La API usa también la conexión directa**, no la del pooler: es la que se
  ensayó, y Neon Free admite de sobra las conexiones de una sola instancia.
  (`set_config(..., true)` es transaccional y funcionaría con el pooler en modo
  transacción, pero Prisma pediría `pgbouncer=true` y no está probado acá.)

### Lo que se midió antes de elegirlo (2026-11-07)

Imagen de producción con `docker run --memory=512m --memory-swap=512m`, API y
workers en el mismo proceso, contra Postgres y Redis locales:

| | RSS |
|---|---|
| En reposo, recién arrancada | 138–141 MB |
| Con carga: 25 WebSockets, ~900 peticiones (logins, 360 tickets con comentario, listados), 13 000 eventos de tiempo real | estable en ~160 MB |
| **Pico** (`VmHWM` del proceso) | **216 MiB** (`memory.peak` del cgroup: 149 MiB) |

Entra con más del doble de margen. El heap que Node 24 elige solo con 512 MB es
de 259 MB (lo deriva del cgroup); igual se fija `NODE_OPTIONS=--max-old-space-size=256`
en `render.yaml` para no depender de que la plataforma lo exponga.

Lo que de verdad aprieta es la **CPU (0.1)**: con `--cpus=0.1` un login (argon2id)
tardó 0.6–1.6 s y el arranque en frío **77 s** hasta `/health/ready` (en esta PC,
con disco lento; en Render debería ser menos, pero del mismo orden). Con el
servicio dormido, la primera visita espera eso.

### Consecuencias del plan gratis (aceptadas)

- **Render Free duerme el servicio** tras unos 15 minutos sin tráfico entrante.
  Dormido, tampoco corren el publicador del outbox ni el barrido de SLA: los
  eventos esperan en `outbox_messages` y los vencimientos en `sla_timers`, y se
  procesan al despertar (ADR-0019/0021: ambos son durables en Postgres). Un SLA
  incumplido mientras dormía se registra al despertar, fechado con su `due_at`.
- **El Key Value Free no persiste.** Un reinicio de Redis pierde los jobs que
  estaban en cola y no se habían procesado (el outbox ya los marcó como
  publicados). Para una demo es aceptable; para producción, plan pago con
  persistencia.
- **Neon Free suspende el cómputo** tras 5 minutos sin consultas. Mientras la API
  está despierta, el publicador consulta cada segundo y lo mantiene activo: se
  consumen horas de cómputo solo mientras alguien usa la demo. Revisar el
  límite mensual del plan Free en el panel de Neon.

### Pasos a mano (Marcos)

**0. Elegir el nombre.** Hace falta ser dueño de la raíz `<nombre>.is-a.dev`
para pedir `app.` y `api.`. Si todavía no la tenés, la raíz puede apuntar al
front (ver el paso 6).

**1. Neon** ([console.neon.tech](https://console.neon.tech), entrar con GitHub)

1. *New project*: Postgres **17**, región **AWS US East 1 (N. Virginia)** (la
   misma zona que `region: virginia` de `render.yaml`).
2. *Roles → New role*: nombre **`helpdesk`**. Copiar la contraseña que muestra
   (se ve una sola vez).
3. *Databases → New database*: nombre **`helpdesk`**, owner **`helpdesk`**. (Si
   el dueño fuera `neondb_owner`, `helpdesk` no podría crear tablas en `public`.)
4. *Connect*: elegir la base `helpdesk`, el rol `helpdesk` y **desactivar
   "Connection pooling"** para obtener el host directo (sin `-pooler`). Anotar el
   host: `ep-xxxx.us-east-1.aws.neon.tech`.

**2. Migrar desde la PC** (Git Bash, en `helpdesk-api`, rama `main`)

```bash
# Contraseña nueva para el rol de la app: hexadecimal, 32+ caracteres.
openssl rand -hex 24          # -> APP_DB_PASSWORD (guardarla: va en Render)

export DATABASE_OWNER_MODE=external
export MIGRATION_DATABASE_URL='postgresql://helpdesk:<pass-de-neon>@<host-directo>/helpdesk?sslmode=require&connect_timeout=30'
export APP_DB_PASSWORD='<hex>'
# Prisma valida que exista aunque migrate no la use:
export DATABASE_URL="$MIGRATION_DATABASE_URL"

corepack pnpm install --frozen-lockfile
corepack pnpm build
node dist/deploy/prepare-database.js owner    # comprueba helpdesk + CREATE temporal
corepack pnpm exec prisma migrate deploy      # 7 migraciones
node dist/deploy/prepare-database.js app      # rota helpdesk_app y retira el CREATE
node dist/deploy/prepare-database.js verify   # 12 tablas con RLS+FORCE, app sin BYPASSRLS
```

`verify` tiene que terminar con `12 tablas con RLS + FORCE; helpdesk_app sin
SUPERUSER ni BYPASSRLS`. Si falla, no seguir: dice qué garantía está rota.

Opcional, datos de demo (org `acme-support`, clave `demo-password-123`). El
seed levanta la app entera, así que necesita un Redis cualquiera; con
`WORKER_ENABLED=0` no encola nada, y el outbox lo drena después la API de Render:

```bash
docker compose -f infra/docker-compose.yml up -d redis
DATABASE_URL='postgresql://helpdesk_app:<APP_DB_PASSWORD>@<host-directo>/helpdesk?sslmode=require' \
REDIS_URL=redis://localhost:6379 WORKER_ENABLED=0 corepack pnpm seed
```

**Cada vez que haya migraciones nuevas** en `main`: repetir `owner` → `migrate
deploy` → `app` → `verify` ANTES de que Render despliegue el código que las
necesita (o pausar el auto-deploy mientras tanto).

**3. Render** ([dashboard.render.com](https://dashboard.render.com), entrar con GitHub)

1. *New → Blueprint*, repo `helpdesk-api`, rama `main`. Lee `render.yaml` y
   propone `helpdesk-api` (web, free) y `helpdesk-redis` (Key Value, free).
2. Pide las variables con `sync: false`:
   - `DATABASE_URL` = `postgresql://helpdesk_app:<APP_DB_PASSWORD>@<host-directo>/helpdesk?schema=public&sslmode=require&connect_timeout=30`
   - `CORS_ORIGINS` = `https://app.<nombre>.is-a.dev` (mientras no haya dominio,
     el de Vercel: `https://<proyecto>.vercel.app`; el login anda pero recargar
     cierra la sesión, ver arriba).
3. Los secretos JWT los genera Render (`generateValue`). `REDIS_URL` sale sola
   de la Key Value.
4. Esperar el primer despliegue y probar
   `https://helpdesk-api-xxxx.onrender.com/health/ready`.
5. *Settings → Custom Domains → Add*: `api.<nombre>.is-a.dev`. Render muestra
   el destino del CNAME (`helpdesk-api-xxxx.onrender.com`). Anotarlo.
6. En los logs, comprobar que el `remoteAddress` de las peticiones sea tu IP y
   no una del proxy. Si es del proxy, subir `TRUST_PROXY_HOPS` a 2 (adenda del
   ADR-0013).

**4. Vercel** ([vercel.com](https://vercel.com), entrar con GitHub)

1. *Add New → Project*, repo `helpdesk-web`. Detecta Next.js solo; no hay
   `vercel.json` porque no hace falta.
2. *Environment Variables* (Production):
   - `NEXT_PUBLIC_API_URL` = `https://api.<nombre>.is-a.dev` (sin barra final).
     Se inlinea en el **build**: cambiarla obliga a redesplegar.
   - `ENABLE_EXPERIMENTAL_COREPACK` = `1`, para que use el pnpm de
     `packageManager` (11) y no el que deduce del lockfile.
3. *Settings → General → Node.js Version*: 24.x (también lo pide `engines`).
4. *Settings → Domains → Add*: `app.<nombre>.is-a.dev`. Vercel muestra el
   CNAME (`cname.vercel-dns.com` o uno propio del proyecto) y, si lo pide, un TXT
   `_vercel`. Anotarlos.

**5. is-a.dev — registros para el PR** (el PR lo escribís vos: su política
prohíbe PRs generados con IA). Un archivo por subdominio en
`domains/` de [is-a-dev/register](https://github.com/is-a-dev/register), con
tu usuario de GitHub en `owner` y `"proxied": false` si lo ofrecen (que
Cloudflare no se meta delante de Render/Vercel):

| Archivo | Tipo | Valor |
|---|---|---|
| `domains/app.<nombre>.json` | CNAME | el que mostró Vercel (p. ej. `cname.vercel-dns.com`) |
| `domains/api.<nombre>.json` | CNAME | el que mostró Render (`helpdesk-api-xxxx.onrender.com`) |
| `domains/_vercel.<nombre>.json` | TXT | solo si Vercel lo pidió: el `vc-domain-verify=...` que muestra |

Render no pide TXT: verifica con el propio CNAME.

**6. Cuando el PR esté mergeado y el DNS propague**

1. Vercel y Render emiten los certificados solos (pulsar *Verify* si no).
2. Render: `CORS_ORIGINS=https://app.<nombre>.is-a.dev` (si no estaba ya) →
   se redespliega solo.
3. Vercel: `NEXT_PUBLIC_API_URL=https://api.<nombre>.is-a.dev` → *Redeploy*.

### Comprobar

- `https://api.<nombre>.is-a.dev/health/ready` → `{"status":"ok",...}` (la
  primera vez tras dormir, hasta ~1 minuto).
- Entrar en `https://app.<nombre>.is-a.dev` con `acme-support` /
  `admin@acme.test` / `demo-password-123` y **recargar**: si la sesión sigue, la
  cookie viaja (mismo sitio).
- Dos pestañas en el mismo ticket: un comentario en una aparece en la otra
  (WebSocket a través del proxy de Render).
- Crear un ticket y ver que se auto-asigna en unos segundos (el worker corre
  dentro de la API).

## Railway

### 1. Proyecto y servicios

En un proyecto nuevo:

1. **Postgres** y **Redis** desde las plantillas de Railway. Dejar sus nombres
   (`Postgres`, `Redis`): las variables de abajo los referencian.
2. **helpdesk-api** desde el repo de GitHub, rama `main`. Toma `railway.json`
   solo: Dockerfile, Pre-Deploy, healthcheck en `/health/ready`, una réplica
   (el rate limiting es en memoria, ADR-0013).
3. **helpdesk-web** desde su repo, rama `main`.

A cada servicio web se le genera un dominio público en *Settings → Networking*.

### 2. Variables de helpdesk-api

Generar cada contraseña con `openssl rand -hex 24` y cada secreto JWT con
`openssl rand -hex 48`. Las contraseñas **tienen** que ser hexadecimales en
minúsculas: el script de roles rechaza cualquier otra cosa (ADR-0026).

```
NODE_ENV=production
WORKER_ENABLED=1
TRUST_PROXY_HOPS=1
LOG_LEVEL=info

OWNER_DB_PASSWORD=<hex>
APP_DB_PASSWORD=<hex>
DATABASE_SUPERUSER_URL=${{Postgres.DATABASE_URL}}
MIGRATION_DATABASE_URL=postgresql://helpdesk:${{OWNER_DB_PASSWORD}}@${{Postgres.PGHOST}}:${{Postgres.PGPORT}}/${{Postgres.PGDATABASE}}?schema=public
DATABASE_URL=postgresql://helpdesk_app:${{APP_DB_PASSWORD}}@${{Postgres.PGHOST}}:${{Postgres.PGPORT}}/${{Postgres.PGDATABASE}}?schema=public
# family=0: la red privada de Railway puede ser solo IPv6, y ioredis (BullMQ y
# el adapter de Socket.io) resuelve IPv4 por defecto. Con 0 prueba las dos.
REDIS_URL=${{Redis.REDIS_URL}}?family=0

JWT_ACCESS_SECRET=<hex>
JWT_REFRESH_SECRET=<hex>

# Mientras no haya dominio propio, el dominio de Railway del front:
CORS_ORIGINS=https://<dominio-del-front>
```

El Pre-Deploy (`railway.json`) corre en cada despliegue, en este orden:

1. `prepare-database.js owner` — crea el rol dueño `helpdesk` con el superusuario
   de Railway (las migraciones asumen ese nombre).
2. `prisma migrate deploy` — con el rol dueño.
3. `prepare-database.js app` — rota la contraseña de `helpdesk_app`, que la
   migración crea con un valor público.
4. `seed` — idempotente: la organización `acme-support` solo se crea una vez.

Si algo falla, Railway no arranca la versión nueva.

### 3. Variables de helpdesk-web

```
NEXT_PUBLIC_API_URL=https://<dominio-de-la-api>
```

Se fija en el **build** (Next inlinea las `NEXT_PUBLIC_*`): cambiarla obliga a
redesplegar el front, no alcanza con reiniciarlo.

### 4. Dominio propio

1. En cada servicio, *Settings → Networking → Custom Domain*:
   `app.<tu-dominio>` en el web y `api.<tu-dominio>` en la API. Railway muestra
   un **CNAME** y un **TXT** de verificación por cada uno.
2. Crear esos registros en el DNS. Con is-a.dev es un Pull Request a
   [is-a-dev/register](https://github.com/is-a-dev/register) con un archivo JSON
   por registro. Hay que ser dueño de la raíz (`<nombre>.is-a.dev`) para pedir
   `app.<nombre>` y `api.<nombre>`. Su política pide que el PR lo escriba uno
   mismo, sin generarlo con IA.
3. Con los dominios verificados, actualizar y redesplegar:
   - API: `CORS_ORIGINS=https://app.<tu-dominio>`
   - Web: `NEXT_PUBLIC_API_URL=https://api.<tu-dominio>`

### Comprobar

- `https://api.<dominio>/health/ready` → `{"status":"ok",...}`
- Entrar al front con `acme-support` / `admin@acme.test` / `demo-password-123`
  y **recargar la página**: si la sesión sigue, la cookie viaja (mismo sitio).
- Dos pestañas en el mismo ticket: un comentario en una aparece en la otra
  (WebSocket a través del proxy de Railway).

## VPS con Docker

En la máquina, los dos repos clonados uno al lado del otro:

```bash
cd helpdesk-api
cp infra/prod.env.example infra/prod.env   # completar
docker compose -f infra/docker-compose.prod.yml --env-file infra/prod.env up -d --build
```

Hace falta que `app.<DOMAIN>` y `api.<DOMAIN>` apunten a la IP de la máquina y que
los puertos 80 y 443 estén abiertos: Caddy pide los certificados solo. En Oracle
Cloud hay que abrirlos en la Security List de la VCN **y** en el firewall de la
propia instancia.

Solo Caddy publica puertos: la API no es alcanzable sin pasar por el proxy, que es
lo que hace seguro `TRUST_PROXY_HOPS=1` (adenda del ADR-0013).
