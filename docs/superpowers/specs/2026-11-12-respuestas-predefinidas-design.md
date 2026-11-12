# Respuestas predefinidas — diseño

**Fecha:** 2026-11-12 · **Estado:** aprobado por el usuario (8 decisiones en chat) ·
**Repos:** `helpdesk-api` + `helpdesk-web` · **ADR:** 0030 (nuevo)

## Por qué

Es lo segundo que un agente extraña el primer día, después de las notas internas
(plan de producto en tres tandas, Tanda 1). El agente escribe veinte veces por día
"Gracias por escribirnos, lo estamos revisando". Zendesk, Freshdesk, Help Scout y
Zammad lo tienen; acá no existe.

El éxito: un agente abre un ticket, elige una respuesta en dos clics (o con `/`),
la ajusta y la manda. Un ADMIN las mantiene desde Configuración.

## Objetivos

- Plantillas de texto **compartidas por organización**.
- Variables simples que se rellenan con datos del ticket.
- Insertar en la caja de respuesta, **editable** antes de enviar.

## No-objetivos

- **No son "macros"**: insertar una plantilla NO cambia estado, prioridad ni
  asignación. Eso es automatización (Tanda 3).
- **No hay plantillas personales** por agente (se puede sumar después: una
  columna `owner_id` nullable, aditiva).
- **No se registra qué plantilla se usó** en un comentario (consecuencia de la
  decisión 4). Reportes de uso quedan fuera.
- Sin carpetas/categorías, sin formato enriquecido (el hilo es texto plano), sin
  adjuntos.

## Anti-objetivos (lo que sería un fracaso aunque funcione)

- Que a un cliente le llegue una variable sin rellenar (`{{clinete.email}}` o
  `{{cliente.email}}` literal).
- Que un VIEWER (cliente) pueda listar las plantillas: revelan cómo trabaja el
  equipo por dentro (misma regla del ADR-0025: el rango se decide por lo que se
  revela).
- Que una plantilla se mande sola sin que el agente la vea.

## Decisiones (aprobadas)

1. **Solo texto.** Sin efectos sobre el ticket.
2. **Compartidas por organización.** ADMIN crea/edita/borra; AGENT lista y usa;
   VIEWER no las ve (403).
3. **Variables cerradas:** `{{ticket.numero}}`, `{{ticket.asunto}}`,
   `{{cliente.email}}`, `{{agente.email}}`. Al GUARDAR, cualquier `{{...}}` fuera
   de esa lista es un error de validación (400) que nombra la variable mala. Se
   tolera espacio interno: `{{ ticket.numero }}` es válida.
4. **Se rellenan en el FRONT al insertar.** El backend guarda y valida plantillas;
   del comentario resultante no sabe nada (es un `POST /tickets/:id/comments`
   normal).
5. **Visibilidad la decide la pestaña activa** ("Responder al cliente" / "Nota
   interna"). La plantilla no tiene visibilidad.
6. **UI:** en el detalle del ticket, botón "Respuestas" junto al editor que abre
   un buscador por título; atajo `/` con el editor VACÍO abre el mismo buscador.
   Página nueva **Configuración → Respuestas** (`/settings/respuestas`) solo ADMIN.
7. **Datos:** tabla `canned_responses` con RLS, título único por tenant (80 car.
   máx., sin vacíos), cuerpo 5000 car. máx., autor y fechas. Auditoría al crear,
   editar y borrar, en la misma transacción.
8. **ADR-0030** + este spec + plan.

## Contrato HTTP (decidido por el asistente, ver "Calls")

| Método | Ruta | Rol mín. | Respuesta |
|---|---|---|---|
| `GET` | `/canned-responses` | AGENT | `{ items: CannedResponse[] }` ordenado por título |
| `POST` | `/canned-responses` | ADMIN | 201 + `CannedResponse` |
| `PUT` | `/canned-responses/:id` | ADMIN | 200 + `CannedResponse` |
| `DELETE` | `/canned-responses/:id` | ADMIN | 204 |

`CannedResponse = { id, title, body, createdAt, updatedAt }`. Body de escritura:
`{ title, body }`. Errores: 400 validación (título/cuerpo/variable), 404 no
existe (o es de otro tenant: RLS lo hace invisible), 409 título duplicado.

## Relleno de variables (front)

| Variable | Valor | Si falta |
|---|---|---|
| `ticket.numero` | `#<number>` | nunca falta |
| `ticket.asunto` | `subject` | nunca falta |
| `cliente.email` | email del `requesterId` en el directorio de miembros | queda LITERAL |
| `agente.email` | email del usuario de la sesión | queda LITERAL |

Si tras rellenar queda algún `{{...}}` en el editor, el botón de enviar sigue
activo pero se muestra un aviso en línea ("Quedó una variable sin rellenar") y el
envío pide una segunda confirmación (no un `confirm()` del navegador: un estado
del propio formulario). Así se cumple el anti-objetivo sin bloquear al agente.

## Calls del asistente (no los pidió el usuario; revisables)

- Vive en el bounded context **ticketing** (`domain/canned-response/`), no en un
  módulo nuevo: es una herramienta del espacio de trabajo del agente y comparte
  `AuditRecorder`, `TransactionManager` y el patrón de `sla-policy`.
- `PUT` reemplaza título y cuerpo juntos (no `PATCH`): el formulario siempre
  manda los dos.
- `DELETE` es borrado físico. La auditoría guarda `title` y `body` en `metadata`
  para que quede rastro de qué se borró.
- Acciones de auditoría: `canned_response.created|updated|deleted`, `entityType`
  `CannedResponse`, `entityId` = id de la plantilla.
- Unicidad del título **sin distinguir mayúsculas ni espacios de los bordes**:
  columna `title_key` (título recortado y en minúsculas, la calcula el dominio)
  con `@@unique([tenantId, titleKey])` en Prisma. Descartado un índice sobre
  `lower(title)` porque Prisma no modela índices de expresión y daría drift
  permanente en `migrate diff`.
- Sin paginación: el envoltorio `{ items }` deja sumar `nextCursor` sin romper
  (mismo criterio que `GET /members`). Tope práctico: nadie mantiene 500
  plantillas.
- Sin evento de integración ni realtime: cambiar una plantilla no le interesa a
  ningún consumidor. El front invalida su query al guardar.
- Seed: 3 plantillas de demo en `acme-support` (solo si la org se crea).

## Restricciones

- Hexagonal, `Result` en dominio/aplicación, branded id `CannedResponseId`.
- RLS ENABLE + FORCE + policy `tenant_isolation` fail-closed, GRANT a
  `helpdesk_app`, como `ticket_triages`.
- `migrate diff` vacío; validar en BD desechable (nunca `migrate reset`).
- `pnpm typecheck`, `lint:ci`, unit y e2e verdes. Web: tests, tsc, eslint, build.
- Textos de UI en español rioplatense, como el resto del front.

## Lo que queda al implementador

Nombres internos, estructura de componentes del front, estilos (siguiendo las
primitivas existentes), forma exacta de los tests.
