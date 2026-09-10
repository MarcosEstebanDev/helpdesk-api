-- ---------------------------------------------------------------------------
-- Correlación de extremo a extremo (ADR-0024)
--
-- El `request_id` de la petición HTTP que originó un evento viaja con él hasta
-- el worker que lo consume. Es lo que permite preguntar "¿qué pasó por culpa de
-- esta petición?" y obtener también los efectos ASÍNCRONOS: la auto-asignación,
-- los relojes de SLA, el aviso por WebSocket. Sin esto, la petición y sus
-- consecuencias son dos historias distintas separadas por unos milisegundos y
-- ninguna forma de unirlas.
--
-- Va en una COLUMNA y no dentro de `payload`: el payload es el contrato de
-- negocio del evento (ADR-0018), y meterle metadatos de infraestructura lo
-- ensuciaría para todos los consumidores.
--
-- Es NULLABLE a propósito: los mensajes escritos antes de esta migración no lo
-- tienen, y tampoco lo tiene lo que se origina fuera de una petición (el barrido
-- de SLA, por ejemplo).
-- ---------------------------------------------------------------------------

ALTER TABLE "outbox_messages" ADD COLUMN "request_id" TEXT;

-- ---------------------------------------------------------------------------
-- El publicador tiene GRANT por COLUMNA sobre esta tabla (ADR-0019, principio de
-- mínimo privilegio), y **un grant por columna no alcanza a las columnas que se
-- añadan después**. Sin esta línea, `outbox_claim_batch` falla con 42501
-- "permission denied for table outbox_messages" en cuanto intenta leer la
-- columna nueva — y el outbox deja de drenarse por completo.
--
-- Es el precio de los grants por columna: cada columna nueva hay que
-- concedérsela a mano. Se paga a cambio de que el publicador no pueda leer ni
-- tocar nada que no necesite.
-- ---------------------------------------------------------------------------
GRANT SELECT (request_id) ON "outbox_messages" TO helpdesk_outbox_publisher;

-- ---------------------------------------------------------------------------
-- La función del publicador tiene que devolver la columna nueva.
--
-- `CREATE OR REPLACE` no sirve: cambia el tipo de retorno, y Postgres lo
-- rechaza. Hay que borrarla y volver a crearla, lo que implica rehacer también
-- su dueño y sus privilegios — que es justo lo que le da sus permisos efectivos
-- (ADR-0019).
-- ---------------------------------------------------------------------------

DROP FUNCTION IF EXISTS outbox_claim_batch(int, int);

CREATE FUNCTION outbox_claim_batch(p_limit int, p_max_attempts int)
RETURNS TABLE (
  id uuid,
  tenant_id uuid,
  aggregate_type text,
  aggregate_id uuid,
  event_name text,
  version int,
  payload jsonb,
  occurred_at timestamp(3),
  request_id text
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
-- search_path fijo: evita que el del llamador secuestre la resolución de nombres
-- dentro de una función definer.
SET search_path = pg_catalog, public
AS $$
BEGIN
  RETURN QUERY
    SELECT m.id, m.tenant_id, m.aggregate_type, m.aggregate_id, m.event_name,
           m.version, m.payload, m.occurred_at, m.request_id
    FROM public.outbox_messages m
    WHERE m.published_at IS NULL
      AND m.attempts < p_max_attempts
    ORDER BY m.occurred_at, m.id
    FOR UPDATE SKIP LOCKED
    LIMIT p_limit;
END
$$;

-- El dueño define los privilegios efectivos de una función SECURITY DEFINER.
GRANT helpdesk_outbox_publisher TO CURRENT_USER;
ALTER FUNCTION outbox_claim_batch(int, int) OWNER TO helpdesk_outbox_publisher;
REVOKE ALL ON FUNCTION outbox_claim_batch(int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION outbox_claim_batch(int, int) TO helpdesk_app;
