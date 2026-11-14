-- Esperando al cliente: estado nuevo y reloj de SLA pausable (ADR-0029).

-- 1. Estado nuevo del ticket. AFTER 'IN_PROGRESS' para que el orden del enum en
--    la base coincida con el de `schema.prisma`: Postgres ordena un enum por su
--    orden de declaración (un ORDER BY status lo nota) y `migrate diff` también.
--    El valor NO se usa en esta migración: un valor añadido con ADD VALUE no se
--    puede usar dentro de la misma transacción que lo crea.
ALTER TYPE "ticket_status" ADD VALUE 'WAITING_ON_CUSTOMER' AFTER 'IN_PROGRESS';

-- 2. Desde cuándo está en pausa un reloj. NULL = no está en pausa. El estado del
--    reloj se sigue DERIVANDO de las fechas: no hay columna `status`.
ALTER TABLE "sla_timers" ADD COLUMN "paused_at" TIMESTAMP(3);

-- 3. El rol del barrido tiene privilegios por COLUMNA sobre `sla_timers`
--    (ADR-0021), y un GRANT por columna NO alcanza a las columnas añadidas
--    después. Sin esta línea `sla_due_timers` falla con 42501 y el barrido deja
--    de funcionar ENTERO, no solo para los relojes pausados (ya pasó con
--    `outbox_messages.request_id` en la fase 8).
GRANT SELECT ("paused_at") ON "sla_timers" TO helpdesk_sla_sweeper;

-- 4. El barrido ignora los relojes en pausa: un ticket esperando al cliente no
--    puede incumplir. Mismo tipo de retorno que la versión de la fase 6, así que
--    CREATE OR REPLACE sirve y conserva el OWNER (helpdesk_sla_sweeper) y los
--    GRANT; con un retorno distinto habría que DROP + CREATE y rehacerlos.
CREATE OR REPLACE FUNCTION sla_due_timers(p_limit int, p_now timestamp(3))
RETURNS TABLE (id uuid, tenant_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT t.id, t.tenant_id
  FROM public.sla_timers t
  WHERE t.stopped_at IS NULL
    AND t.breached_at IS NULL
    AND t.paused_at IS NULL
    AND t.due_at <= p_now
  ORDER BY t.due_at
  LIMIT p_limit;
$$;
