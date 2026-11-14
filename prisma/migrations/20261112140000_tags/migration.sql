-- =============================================================================
-- Etiquetas (ADR-0031).
--
-- Catálogo por organización (`tags`) y relación con los tickets (`ticket_tags`).
-- `ticket_tags` lleva `tenant_id` propio para que la policy de RLS sea idéntica
-- a la del resto del esquema. Sin roles nuevos ni funciones SECURITY DEFINER.
-- =============================================================================

-- CreateTable
CREATE TABLE "tags" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "name_key" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ticket_tags" (
    "ticket_id" UUID NOT NULL,
    "tag_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,

    CONSTRAINT "ticket_tags_pkey" PRIMARY KEY ("ticket_id","tag_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tags_tenant_id_name_key_key" ON "tags"("tenant_id", "name_key");

-- CreateIndex
CREATE INDEX "ticket_tags_tenant_id_tag_id_idx" ON "ticket_tags"("tenant_id", "tag_id");

-- AddForeignKey
ALTER TABLE "tags" ADD CONSTRAINT "tags_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_tags" ADD CONSTRAINT "ticket_tags_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_tags" ADD CONSTRAINT "ticket_tags_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_tags" ADD CONSTRAINT "ticket_tags_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- =============================================================================
-- Row-Level Security (ADR-0010), igual que el resto del esquema.
-- =============================================================================

GRANT SELECT, INSERT, UPDATE, DELETE ON "tags" TO helpdesk_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "ticket_tags" TO helpdesk_app;

ALTER TABLE "tags" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tags" FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "tags"
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

ALTER TABLE "ticket_tags" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ticket_tags" FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "ticket_tags"
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
