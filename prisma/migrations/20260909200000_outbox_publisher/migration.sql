-- =============================================================================
-- Fase 5b — Publicador del outbox e idempotencia de los consumidores.
--
-- Dos piezas:
--   1. Un rol dedicado que permite al publicador leer el outbox de TODOS los
--      tenants sin abrir RLS para nadie más (ADR-0019).
--   2. `processed_messages`, el registro de lo ya procesado por cada consumidor.
-- =============================================================================

-- CreateTable
CREATE TABLE "processed_messages" (
    "consumer" TEXT NOT NULL,
    "event_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "processed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processed_messages_pkey" PRIMARY KEY ("consumer","event_id")
);

-- AddForeignKey
ALTER TABLE "processed_messages" ADD CONSTRAINT "processed_messages_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- La clave primaria (consumer, event_id) ES la garantía de idempotencia: el
-- consumidor la inserta en la MISMA transacción que su efecto, así que un
-- reintento choca contra ella y no repite el trabajo.
GRANT SELECT, INSERT, UPDATE, DELETE ON "processed_messages" TO helpdesk_app;

ALTER TABLE "processed_messages" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "processed_messages" FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "processed_messages"
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- =============================================================================
-- Rol del publicador (ADR-0019), mismo patrón de mínimo privilegio que el ADR-0012.
--
-- Problema: el publicador corre en un bucle de fondo, no dentro de una request,
-- así que no hay JWT del que sacar el tenant y `app.current_tenant` está vacío.
-- Las policies son fail-closed y `outbox_messages` tiene FORCE ROW LEVEL SECURITY
-- —que aplica también al dueño de la tabla—, de modo que no vería NI UNA fila.
--
-- Solución: un rol NOLOGIN, sin BYPASSRLS, con permisos a nivel de COLUMNA sobre
-- una ÚNICA tabla, dueño de tres funciones SECURITY DEFINER que solo `helpdesk_app`
-- puede ejecutar. Aunque una de ellas se viera comprometida, lo máximo que expone
-- es el outbox; no abre el resto del esquema ni depende de tener un superusuario.
-- =============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'helpdesk_outbox_publisher') THEN
    CREATE ROLE helpdesk_outbox_publisher NOLOGIN;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO helpdesk_outbox_publisher;

-- Solo lo que necesita para su trabajo: leer los mensajes y marcar el resultado.
-- No puede insertar ni borrar, ni tocar `tenant_id` o `payload`.
GRANT SELECT (id, tenant_id, aggregate_type, aggregate_id, event_name, version,
              payload, occurred_at, published_at, attempts)
  ON "outbox_messages" TO helpdesk_outbox_publisher;
GRANT UPDATE (published_at, attempts, last_error)
  ON "outbox_messages" TO helpdesk_outbox_publisher;

-- Sin estas policies el rol quedaría bloqueado por RLS igual que cualquier otro.
-- Son la ÚNICA excepción al aislamiento por tenant, y solo sobre esta tabla.
CREATE POLICY outbox_publisher_read ON "outbox_messages"
  FOR SELECT TO helpdesk_outbox_publisher
  USING (true);

CREATE POLICY outbox_publisher_mark ON "outbox_messages"
  FOR UPDATE TO helpdesk_outbox_publisher
  USING (true)
  WITH CHECK (true);

-- -----------------------------------------------------------------------------
-- Reclamar un lote de mensajes pendientes.
--
-- `FOR UPDATE SKIP LOCKED` es lo que permite tener varias instancias de la API
-- publicando a la vez: cada una se lleva filas distintas en vez de bloquearse
-- unas a otras. Los bloqueos duran hasta que la transacción del llamador termina,
-- así que el publicador debe encolar y marcar rápido y cerrar.
--
-- El filtro por `attempts` evita que un mensaje envenenado —uno que revienta al
-- encolarse una y otra vez— monopolice el lote y frene a los que van detrás.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION outbox_claim_batch(p_limit int, p_max_attempts int)
RETURNS TABLE (
  id uuid,
  tenant_id uuid,
  aggregate_type text,
  aggregate_id uuid,
  event_name text,
  version int,
  payload jsonb,
  occurred_at timestamp(3)
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
-- search_path fijo: evita que el del llamador secuestre la resolución de nombres
-- dentro de una función definer (CVE clásico de Postgres).
SET search_path = pg_catalog, public
AS $$
BEGIN
  RETURN QUERY
    SELECT m.id, m.tenant_id, m.aggregate_type, m.aggregate_id, m.event_name,
           m.version, m.payload, m.occurred_at
    FROM public.outbox_messages m
    WHERE m.published_at IS NULL
      AND m.attempts < p_max_attempts
    ORDER BY m.occurred_at, m.id
    FOR UPDATE SKIP LOCKED
    LIMIT p_limit;
END
$$;

CREATE OR REPLACE FUNCTION outbox_mark_published(p_ids uuid[])
RETURNS void
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  UPDATE public.outbox_messages
     SET published_at = now()
   WHERE id = ANY(p_ids)
     AND published_at IS NULL;
$$;

CREATE OR REPLACE FUNCTION outbox_mark_failed(p_id uuid, p_error text)
RETURNS void
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  UPDATE public.outbox_messages
     SET attempts = attempts + 1,
         -- Se recorta: el error solo sirve para diagnosticar, y una traza enorme
         -- multiplicada por miles de filas es un problema de almacenamiento.
         last_error = left(p_error, 1000)
   WHERE id = p_id;
$$;

-- El dueño de la función define sus privilegios efectivos: ese es todo el punto.
GRANT helpdesk_outbox_publisher TO CURRENT_USER;
ALTER FUNCTION outbox_claim_batch(int, int)    OWNER TO helpdesk_outbox_publisher;
ALTER FUNCTION outbox_mark_published(uuid[])   OWNER TO helpdesk_outbox_publisher;
ALTER FUNCTION outbox_mark_failed(uuid, text)  OWNER TO helpdesk_outbox_publisher;

REVOKE ALL ON FUNCTION outbox_claim_batch(int, int)   FROM PUBLIC;
REVOKE ALL ON FUNCTION outbox_mark_published(uuid[])  FROM PUBLIC;
REVOKE ALL ON FUNCTION outbox_mark_failed(uuid, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION outbox_claim_batch(int, int)   TO helpdesk_app;
GRANT EXECUTE ON FUNCTION outbox_mark_published(uuid[])  TO helpdesk_app;
GRANT EXECUTE ON FUNCTION outbox_mark_failed(uuid, text) TO helpdesk_app;
