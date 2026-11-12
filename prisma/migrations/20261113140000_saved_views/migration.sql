-- =============================================================================
-- Vistas guardadas (ADR-0033).
--
-- `owner_id` NULL = compartida. `scope_key` ('shared' o el id del dueño) existe
-- porque Postgres no trata los NULL como iguales en un índice único: sin ella,
-- dos vistas compartidas podrían llamarse igual.
-- =============================================================================

-- CreateTable
CREATE TABLE "saved_views" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "owner_id" UUID,
    "scope_key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "name_key" TEXT NOT NULL,
    "filters" JSONB NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "saved_views_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "saved_views_tenant_id_scope_key_name_key_key" ON "saved_views"("tenant_id", "scope_key", "name_key");

-- AddForeignKey
ALTER TABLE "saved_views" ADD CONSTRAINT "saved_views_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- =============================================================================
-- Row-Level Security (ADR-0010), igual que el resto del esquema.
-- =============================================================================

GRANT SELECT, INSERT, UPDATE, DELETE ON "saved_views" TO helpdesk_app;

ALTER TABLE "saved_views" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "saved_views" FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "saved_views"
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
