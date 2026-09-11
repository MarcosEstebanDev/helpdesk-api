# Roadmap y estado — helpdesk

> Escrito el **2026-09-10** al cerrar la sesión. Cubre los DOS repos
> (`helpdesk-api` y `helpdesk-web`) porque el plan de trabajo vive acá, en el
> backend, igual que el resto del contexto del proyecto.
>
> Para el detalle de *cómo* está hecho cada cosa, `CLAUDE.md` de cada repo. Este
> archivo es solo el "dónde estamos y qué sigue".

---

## 1. Dónde estamos

Las dos ramas `dev` están al día y pusheadas. `main` sigue en el estado previo a
esta tanda, a la espera de que decidas mergear.

| | `helpdesk-api` | `helpdesk-web` |
|---|---|---|
| Unit | 186/186 ✓ | 75/75 ✓ |
| E2E | **126/126 ✓** (Postgres + Redis reales) | — |
| typecheck · lint · build | ✓ | ✓ |
| Rama con el trabajo | `dev` | `dev` |

**Los dos repos son PÚBLICOS.** (El `CLAUDE.md` decía que el api era privado y
estaba desactualizado; corregido.) Escaneado antes de confirmarlo: `.env` nunca
estuvo versionado en toda la historia, y los únicos secretos escritos en el repo
son de CI, demo y tests, cada uno declarándolo en su propio valor.

### Qué entró en esta tanda

**Backend** (`feat/members-endpoint` → `dev`, ADR-0025):
- `GET /members` — directorio de la organización, `@MinRole('AGENT')`.
- `GET /auth/me` ahora devuelve `email` (leído de la base; el `role` sigue
  saliendo del token).
- `GET /tickets` acepta `requesterId`, simétrico a `assigneeId`.

**Frontend** (`ux/atlassian-redesign` + `feat/pendientes-front` → `dev`):
- Lenguaje visual del Atlassian Design System, tema claro/oscuro/sistema,
  avisos de resultado en las mutaciones, destello en las filas que cambian por
  WebSocket.
- Límites de error en tres niveles + pantalla de 404.
- Filtro "Mis tickets" (por asignación para un agente, por autoría para un
  VIEWER).
- Pestaña de historial de auditoría.
- Selector de personas para asignar, con el rol de cada una a la vista.

### Cómo levantar el entorno local

Al cerrar la sesión quedó todo corriendo. Para rearmarlo desde cero:

```bash
# 1. Base de datos y cache (solo estos dos; el compose de demo va aparte)
cd helpdesk-api
docker compose -f infra/docker-compose.yml up -d
corepack pnpm prisma:deploy
corepack pnpm seed            # idempotente

# 2. API con workers, en :3000
WORKER_ENABLED=1 corepack pnpm start:dev

# 3. Front, en :3001 (es el único origen que acepta CORS_ORIGINS)
cd ../helpdesk-web
corepack pnpm build && PORT=3001 corepack pnpm start
```

Hace falta un `.env` en `helpdesk-api` (está en `.gitignore`): copiar
`.env.example` y poner cualquier par de secretos de 32+ caracteres. **`WORKER_ENABLED=0`
en el `.env`**, porque el seed no debe drenar su propio outbox; los workers se
levantan pasando la variable en el comando de arranque.

Credenciales del seed: organización `acme-support`, contraseña
`demo-password-123`, usuarios `admin@acme.test`, `agent@acme.test`,
`viewer@acme.test`.

**Para ver la diferencia entre roles** —que es lo mejor de la interfaz— entrar
como admin y después como viewer: el segundo no ve la pestaña de historial ni el
selector de personas, su filtro dice "Los que abrí yo" en vez de "Mis tickets",
y en la conversación lee papeles ("Solicitante") en vez de correos.

---

## 2. Pendiente inmediato, ya diseñado

**Nombres de los participantes para un VIEWER.** Hoy un agente ve los correos de
quienes escriben en un ticket (porque tiene `GET /members`) y un VIEWER ve solo
papeles. Falta enriquecer **`GET /tickets/:id`** con los participantes de ESE
ticket — gente con la que el solicitante ya está hablando— en vez de aflojar el
directorio, que es para el personal.

Preguntas de diseño abiertas, a resolver antes de codear:
- ¿Se expone el email del asignado que todavía no habló en el ticket?
- ¿Qué se muestra de alguien que se dio de baja pero sigue en la conversación?
- ¿Va dentro de cada comentario o como un mapa `participants` a nivel del ticket?

---

## 3. Qué mejorar del producto

Diagnóstico del 2026-09-10 después de usarlo en local. **Ojo con la tensión de
fondo:** el objetivo declarado del proyecto es *mostrar decisiones de
arquitectura, no cantidad de features*. Sumar veinte funciones no mejora el
portfolio, lo diluye. Por eso lo de abajo está ordenado por "¿es producto Y
arquitectura a la vez?", no por tamaño.

### 3.1 Lo que se nota en el primer minuto de uso

| Falta | Por qué duele | Esfuerzo |
|---|---|---|
| **Búsqueda** | Un helpdesk sin buscar es inusable pasando los 50 tickets. `GET /tickets` filtra por estado, asignado y solicitante, y nada más | Bajo (full-text de Postgres) |
| **Cambiar la prioridad** | Se fija al abrir el ticket y queda congelada. `ticket.priority_changed` está en el enum de auditoría y **ningún caso de uso la emite**: no hay endpoint | ~1 hora |
| **Notas internas** | Todo comentario es público. Los agentes no pueden discutir sin que lo vea el cliente | Bajo |
| **Adjuntos** | Un ticket de soporte sin captura no es un ticket de soporte | Medio (almacenamiento de archivos) |
| **Nadie tiene nombre** | No hay columna `name`: todo son correos. Es la causa principal de que se vea a medio terminar | Bajo, pero toca registro, seed y DTOs |
| **Acciones masivas** | Un agente no puede seleccionar diez tickets y cerrarlos | Medio |
| **Plantillas de respuesta** | Es el ahorro de tiempo número uno en soporte real | Medio |

### 3.2 Lo que falta para que sea un producto y no una demo

- **Email entrante.** `InboundEmail` está en el modelo de dominio objetivo y no
  existe el módulo. Un helpdesk existe *por* el email: si el cliente no puede
  escribir a soporte@ y que eso abra un ticket, es un gestor de tareas.
- **Nadie puede sumar gente.** Se puede *listar* miembros pero no invitar ni
  cambiar roles. El seed los inserta a mano. Una organización real no arranca.
- **El SLA no conoce horario laboral.** La interfaz `SlaCalendar` existe con una
  sola implementación, `CALENDAR_24_7`, así que un ticket abierto un viernes a
  las 18:00 incumple el sábado.
- **Incumplir un SLA no hace nada.** Se audita y se emite un evento; no hay
  escalado, ni reasignación, ni aviso a nadie.
- **Sin notificaciones fuera de la pantalla.** El realtime solo sirve si estás
  mirando. La room `user:<id>` sigue sin existir.
- **Sin métricas.** Ningún agregado: tickets por estado, cumplimiento de SLA,
  tiempo medio de respuesta.

### 3.3 Deuda técnica ya conocida

- **El cliente REST del front sigue escrito a mano.** El ADR-0004 dice que se
  genera desde el OpenAPI y no se hizo: hoy un cambio de DTO en el backend **no
  rompe la compilación** del frontend. Es la deuda que más dice sobre disciplina
  de contratos.
- **El contrato del WebSocket se mantiene a ojo** (`lib/realtime/events.ts`). No
  sale del OpenAPI y no tiene salida fácil salvo generar ambos lados desde un
  esquema compartido.
- **`AssignTicket` manual acepta a cualquier miembro** (solo mira `isMember`, no
  el rol) mientras la auto-asignación reparte solo entre AGENT y ADMIN. Mitigado
  mostrando el rol en el selector; endurecerlo es un cambio de negocio.
- **`sla_timers` crece con cada ticket y nadie lo purga.**
- **Rate limiting en memoria** (ADR-0013): con dos instancias de API, el límite
  se multiplica por dos.
- **Nadie vigila los eventos que el consumidor de realtime ignora** por no tener
  `case`: devuelve `ignored` y queda solo en el log del job.

### 3.4 El orden que recomiendo

1. **Email entrante.** La que más pesa de las dos maneras. Como producto, es lo
   que convierte esto en un helpdesk. Como arquitectura, es **la prueba de que el
   hexagonal valió la pena**: un segundo camino de entrada al mismo dominio sin
   tocar los casos de uso. Trae además verificación de firma de webhook,
   idempotencia sobre los reintentos del proveedor y sanitización de HTML — tres
   cosas que el modelo de seguridad ya declara y que hoy no se ejercitan.
2. **Calendario laboral en el SLA.** Barata y elegante: la costura ya está, solo
   está vacía. Llenarla demuestra que la abstracción no era decorativa, que es la
   crítica que recibe toda interfaz con una sola implementación.
3. **El paquete corto que quita la sensación de MVP**: búsqueda + cambio de
   prioridad + notas internas + nombres de persona.

**Lo que NO haría ahora:** adjuntos (mete almacenamiento de archivos y no
demuestra nada nuevo), métricas (esperan a tener datos de verdad) y billing
(repite patrones ya mostrados con el outbox).

---

## 4. Despliegue

Hoy **no está desplegado en ningún lado**: ningún archivo de plataforma en
ninguno de los dos repos, y el CI tiene un solo job (`verify`) que no publica
imagen ni despliega.

### Cuatro restricciones que salen del propio código

1. **La cookie de refresh es `SameSite=Lax`** (`auth.controller.ts`). Si el front
   y la API quedan en dominios distintos (`*.vercel.app` y `*.fly.dev`), el
   navegador **no manda la cookie** en el `fetch` con `credentials: 'include'`:
   recargar la página cerraría la sesión, siempre. CORS no lo arregla — CORS
   permite, `SameSite` prohíbe. La salida **no** es `SameSite=None` (bloqueo de
   cookies de terceros), es **un dominio con dos subdominios**:
   `app.tudominio.com` y `api.tudominio.com` son el mismo *site*.
2. **Workers y WebSocket necesitan procesos largos.** El publicador por polling,
   el barrido de SLA y Socket.io no sobreviven en serverless: **Vercel queda
   descartado para el backend** (para el front es ideal).
3. **Postgres tiene que permitir `CREATE ROLE`.** Las migraciones crean cuatro
   roles y funciones `SECURITY DEFINER`. Y si hay pooler, **modo transacción**:
   `set_config('app.current_tenant', …, true)` es transaccional, y *statement
   mode* rompería RLS en silencio, que es el peor fallo posible.
4. **El rate limiting es en memoria**: una sola instancia de API hasta moverlo a
   Redis.

### Recomendación

| Pieza | Dónde | Por qué |
|---|---|---|
| API | Railway, `api.tudominio.com` | Proceso largo, WebSocket, healthcheck en `/health/ready`. Una sola instancia por ahora |
| Worker | Railway, segundo servicio de la misma imagen | Solo cambia `WORKER_ENABLED=1` |
| Postgres | Railway Postgres | Red privada con la API, sin egreso, y deja crear roles |
| Redis | Railway Redis | BullMQ necesita Redis de verdad, con comandos bloqueantes |
| Front | Vercel, `app.tudominio.com` | Es Next.js. Con dominio propio sigue siendo *same-site* con la API |

Unos 5–10 USD al mes, más el dominio. La alternativa barata es Fly.io + Neon +
Upstash: tres paneles y tres facturas para ahorrar poco.

**Configuración a cambiar (nada de código):** `CORS_ORIGINS=https://app.tudominio.com`,
`NEXT_PUBLIC_API_URL` como build arg (ya lo es, y se inlinea en build: hay que
reconstruir por ambiente), secretos JWT nuevos, `MIGRATION_DATABASE_URL` con el
rol owner, y `prisma migrate deploy` como paso de release antes de arrancar.

El CI ya construye la imagen pero no la publica: agregarle el push al registry y
el deploy es corto.

---

## 5. Decisiones pendientes de tu parte

- [ ] ¿Mergear `dev` → `main` en los dos repos? Los e2e están en verde, que era
      la condición. Primero el api, porque el front consume sus endpoints.
- [ ] ¿Desplegar, o seguir con features?
- [ ] ¿Endurecer `AssignTicket` a AGENT+, o dejarlo mitigado por la interfaz?
- [ ] Los ADRs están en español y el README en inglés. Ahora que el api es
      público, un párrafo en inglés al principio del índice de ADRs explicando
      qué son y por qué están en español costaría cinco minutos.
