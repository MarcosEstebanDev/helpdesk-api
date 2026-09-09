-- =============================================================================
-- Fase 4 — Ticketing: tickets, comentarios, auditoría y numeración por tenant.
--
-- Mismo patrón multi-tenant que el resto del esquema (ADR-0003 / ADR-0010):
-- toda tabla lleva `tenant_id`, RLS en modo ENABLE + FORCE, y policies
-- fail-closed con NULLIF sobre el GUC `app.current_tenant`.
-- =============================================================================

-- CreateEnum
CREATE TYPE "ticket_status" AS ENUM ('OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED');

-- CreateEnum
CREATE TYPE "ticket_priority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');

-- CreateTable
CREATE TABLE "tickets" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "subject" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "status" "ticket_status" NOT NULL DEFAULT 'OPEN',
    "priority" "ticket_priority" NOT NULL DEFAULT 'NORMAL',
    "requester_id" UUID NOT NULL,
    "assignee_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "resolved_at" TIMESTAMP(3),
    "closed_at" TIMESTAMP(3),

    CONSTRAINT "tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "comments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "author_id" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "actor_id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" UUID NOT NULL,
    "metadata" JSONB,
    "occurred_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ticket_counters" (
    "tenant_id" UUID NOT NULL,
    "next_number" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "ticket_counters_pkey" PRIMARY KEY ("tenant_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tickets_tenant_id_number_key" ON "tickets"("tenant_id", "number");

-- CreateIndex
CREATE INDEX "tickets_tenant_id_status_created_at_idx" ON "tickets"("tenant_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "tickets_tenant_id_assignee_id_status_idx" ON "tickets"("tenant_id", "assignee_id", "status");

-- CreateIndex
CREATE INDEX "comments_tenant_id_ticket_id_created_at_idx" ON "comments"("tenant_id", "ticket_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_tenant_id_entity_type_entity_id_occurred_at_idx" ON "audit_logs"("tenant_id", "entity_type", "entity_id", "occurred_at");

-- CreateIndex
CREATE INDEX "audit_logs_tenant_id_occurred_at_idx" ON "audit_logs"("tenant_id", "occurred_at");

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_requester_id_fkey" FOREIGN KEY ("requester_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_assignee_id_fkey" FOREIGN KEY ("assignee_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_counters" ADD CONSTRAINT "ticket_counters_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- =============================================================================
-- Row-Level Security (ADR-0010).
--
-- El GRANT es explícito y no se confía al ALTER DEFAULT PRIVILEGES de la primera
-- migración: aquel solo cubre objetos creados por el rol `helpdesk`, y no
-- queremos que el aislamiento dependa de qué rol ejecutó la migración.
-- =============================================================================

GRANT SELECT, INSERT, UPDATE, DELETE ON "tickets"         TO helpdesk_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "comments"        TO helpdesk_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "audit_logs"      TO helpdesk_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "ticket_counters" TO helpdesk_app;

ALTER TABLE "tickets"         ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tickets"         FORCE  ROW LEVEL SECURITY;
ALTER TABLE "comments"        ENABLE ROW LEVEL SECURITY;
ALTER TABLE "comments"        FORCE  ROW LEVEL SECURITY;
ALTER TABLE "audit_logs"      ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_logs"      FORCE  ROW LEVEL SECURITY;
ALTER TABLE "ticket_counters" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ticket_counters" FORCE  ROW LEVEL SECURITY;

-- NULLIF colapsa "sin setear" y "reseteado a cadena vacía" a NULL, de modo que
-- sin contexto de tenant ninguna fila matchea (fail-closed) en vez de reventar
-- con 22P02 al castear la cadena vacía a uuid.
CREATE POLICY tenant_isolation ON "tickets"
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

CREATE POLICY tenant_isolation ON "comments"
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

CREATE POLICY tenant_isolation ON "audit_logs"
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

CREATE POLICY tenant_isolation ON "ticket_counters"
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- =============================================================================
-- Nota sobre la numeración visible (ADR-0017).
--
-- No se usa una SEQUENCE: es global al esquema (no por tenant), no es
-- transaccional —un rollback deja un hueco en la numeración— y una secuencia por
-- organización obligaría a ejecutar DDL cada vez que alguien se registra.
--
-- En su lugar, `ticket_counters` guarda una fila por tenant y el número se
-- reserva con un UPSERT que toma el bloqueo exclusivo de esa fila:
--
--   INSERT INTO ticket_counters (tenant_id, next_number) VALUES ($1, 2)
--   ON CONFLICT (tenant_id) DO UPDATE SET next_number = ticket_counters.next_number + 1
--   RETURNING next_number - 1;
--
-- Al correr dentro de la transacción del ticket, dos altas simultáneas del mismo
-- tenant se serializan en esa fila y jamás obtienen el mismo número; si la
-- transacción aborta, el número vuelve atrás con ella. Tenants distintos tocan
-- filas distintas, así que no se estorban.
-- =============================================================================
