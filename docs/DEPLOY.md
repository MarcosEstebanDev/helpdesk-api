# Despliegue

Dos caminos, con el mismo esquema de roles de base de datos (ADR-0026):

- **Railway** (el que se usa): un servicio por pieza, migraciones en el
  Pre-Deploy. Plan Hobby, 5 USD/mes.
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
