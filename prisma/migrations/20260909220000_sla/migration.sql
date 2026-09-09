-- =============================================================================
-- Fase 6 — Motor de SLA (ADR-0020 / ADR-0021).
--
-- Dos tablas y un rol dedicado para el barrido, siguiendo el mismo patrón de
-- mínimo privilegio del ADR-0012 (login por slug) y del ADR-0019 (publicador).
-- =============================================================================

-- CreateEnum
CREATE TYPE "sla_kind" AS ENUM ('RESPONSE', 'RESOLUTION');

-- CreateTable
CREATE TABLE "sla_policies" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "priority" "ticket_priority" NOT NULL,
    "response_minutes" INTEGER NOT NULL,
    "resolution_minutes" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sla_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sla_timers" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "kind" "sla_kind" NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL,
    "due_at" TIMESTAMP(3) NOT NULL,
    "stopped_at" TIMESTAMP(3),
    "breached_at" TIMESTAMP(3),

    CONSTRAINT "sla_timers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sla_policies_tenant_id_priority_key" ON "sla_policies"("tenant_id", "priority");

-- Un ticket tiene como mucho un reloj de cada tipo. Esta restricción ES la
-- garantía de idempotencia al arrancarlos: un evento reprocesado choca aquí.
-- CreateIndex
CREATE UNIQUE INDEX "sla_timers_ticket_id_kind_key" ON "sla_timers"("ticket_id", "kind");

-- CreateIndex
CREATE INDEX "sla_timers_due_at_idx" ON "sla_timers"("due_at");

-- CreateIndex
CREATE INDEX "sla_timers_tenant_id_ticket_id_idx" ON "sla_timers"("tenant_id", "ticket_id");

-- AddForeignKey
ALTER TABLE "sla_policies" ADD CONSTRAINT "sla_policies_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sla_timers" ADD CONSTRAINT "sla_timers_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sla_timers" ADD CONSTRAINT "sla_timers_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- =============================================================================
-- Row-Level Security (ADR-0010), igual que el resto del esquema.
-- =============================================================================

GRANT SELECT, INSERT, UPDATE, DELETE ON "sla_policies" TO helpdesk_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "sla_timers"   TO helpdesk_app;

ALTER TABLE "sla_policies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sla_policies" FORCE  ROW LEVEL SECURITY;
ALTER TABLE "sla_timers"   ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sla_timers"   FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "sla_policies"
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

CREATE POLICY tenant_isolation ON "sla_timers"
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- =============================================================================
-- Rol del barrido de SLA (ADR-0021).
--
-- Mismo problema que el publicador del outbox: el barrido corre fuera de toda
-- request, sin `app.current_tenant`, y con policies fail-closed no vería nada.
--
-- Pero aquí la exposición es MUCHO menor que en el ADR-0019: la función devuelve
-- solo `(id, tenant_id)` de los relojes vencidos. Con ese par, el barrido abre
-- `withTenant(tenant_id)` y hace TODO el trabajo real —leer el reloj, leer el
-- ticket, marcar, auditar, publicar el evento— bajo RLS normal, como cualquier
-- request. La grieta en el aislamiento se reduce a dos columnas y a una lectura.
--
-- El rol ni siquiera necesita UPDATE: marcar el incumplimiento lo hace el rol de
-- aplicación, ya dentro del contexto del tenant.
-- =============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'helpdesk_sla_sweeper') THEN
    CREATE ROLE helpdesk_sla_sweeper NOLOGIN;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO helpdesk_sla_sweeper;

-- Privilegio a nivel de COLUMNA: no puede ver ni las fechas ni de qué ticket es.
GRANT SELECT (id, tenant_id, due_at, stopped_at, breached_at)
  ON "sla_timers" TO helpdesk_sla_sweeper;

CREATE POLICY sla_sweeper_read ON "sla_timers"
  FOR SELECT TO helpdesk_sla_sweeper
  USING (true);

-- -----------------------------------------------------------------------------
-- Relojes vencidos, de todos los tenants.
--
-- Sin `FOR UPDATE`: no hace falta bloquear. Si dos barridos concurrentes cogen el
-- mismo reloj, ambos intentan marcarlo con un UPDATE condicionado a
-- `breached_at IS NULL AND stopped_at IS NULL`, y solo uno afecta a una fila. La
-- idempotencia sale de la condición, no de un bloqueo — y así el barrido no
-- mantiene una transacción abierta mientras hace su trabajo por tenant.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION sla_due_timers(p_limit int, p_now timestamp(3))
RETURNS TABLE (id uuid, tenant_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
-- search_path fijo: evita que el del llamador secuestre la resolución de nombres
-- dentro de una función definer (CVE clásico de Postgres).
SET search_path = pg_catalog, public
AS $$
  SELECT t.id, t.tenant_id
  FROM public.sla_timers t
  WHERE t.stopped_at IS NULL
    AND t.breached_at IS NULL
    AND t.due_at <= p_now
  ORDER BY t.due_at
  LIMIT p_limit;
$$;

GRANT helpdesk_sla_sweeper TO CURRENT_USER;
ALTER FUNCTION sla_due_timers(int, timestamp(3)) OWNER TO helpdesk_sla_sweeper;

REVOKE ALL ON FUNCTION sla_due_timers(int, timestamp(3)) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sla_due_timers(int, timestamp(3)) TO helpdesk_app;
