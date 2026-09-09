-- =============================================================================
-- Fase 5a — Outbox transaccional (ADR-0007 / ADR-0018).
--
-- Los eventos de integración se escriben en esta tabla dentro de la MISMA
-- transacción que el cambio que los produjo. El publicador que la drena llega en
-- la fase 5b, junto con su rol dedicado y sus funciones SECURITY DEFINER.
-- =============================================================================

-- CreateTable
CREATE TABLE "outbox_messages" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "aggregate_type" TEXT NOT NULL,
    "aggregate_id" UUID NOT NULL,
    "event_name" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "payload" JSONB NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "published_at" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,

    CONSTRAINT "outbox_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "outbox_messages_published_at_occurred_at_idx" ON "outbox_messages"("published_at", "occurred_at");

-- CreateIndex
-- OJO con el nombre: Postgres trunca los identificadores a 63 caracteres, y
-- Prisma espera exactamente el nombre ya truncado. Alargarlo produce drift.
CREATE INDEX "outbox_messages_tenant_id_aggregate_type_aggregate_id_occur_idx" ON "outbox_messages"("tenant_id", "aggregate_type", "aggregate_id", "occurred_at");

-- AddForeignKey
ALTER TABLE "outbox_messages" ADD CONSTRAINT "outbox_messages_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- =============================================================================
-- Row-Level Security (ADR-0010), igual que el resto del esquema.
--
-- Ojo con la consecuencia: el rol de aplicación SOLO ve el outbox de su tenant.
-- Es lo correcto para la escritura (un caso de uso jamás debe escribir eventos
-- de otra organización), pero significa que el publicador —que corre fuera de
-- toda request y por tanto sin `app.current_tenant`— no vería NI UNA fila.
-- Ese problema lo resuelve la fase 5b con un rol dedicado, siguiendo el mismo
-- patrón de mínimo privilegio del ADR-0012.
-- =============================================================================

GRANT SELECT, INSERT, UPDATE, DELETE ON "outbox_messages" TO helpdesk_app;

ALTER TABLE "outbox_messages" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "outbox_messages" FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "outbox_messages"
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
