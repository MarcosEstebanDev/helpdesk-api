-- =============================================================================
-- Respuestas predefinidas (ADR-0030).
--
-- Una tabla por organización, con RLS como todo lo demás. Ningún rol nuevo ni
-- función SECURITY DEFINER: la usan los casos de uso dentro de `withTenant` con
-- el rol de aplicación.
-- =============================================================================

-- CreateTable
CREATE TABLE "canned_responses" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    -- Título recortado y en minúsculas: la unicidad no distingue mayúsculas sin
    -- un índice de expresión (Prisma no los modela y daría drift).
    "title_key" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "canned_responses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "canned_responses_tenant_id_title_key_key" ON "canned_responses"("tenant_id", "title_key");

-- AddForeignKey
ALTER TABLE "canned_responses" ADD CONSTRAINT "canned_responses_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- =============================================================================
-- Row-Level Security (ADR-0010), igual que el resto del esquema.
-- =============================================================================

GRANT SELECT, INSERT, UPDATE, DELETE ON "canned_responses" TO helpdesk_app;

ALTER TABLE "canned_responses" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "canned_responses" FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "canned_responses"
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
