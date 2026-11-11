-- =============================================================================
-- Triage con IA (ADR-0027).
--
-- Una tabla con la sugerencia del clasificador, una fila por ticket. Ningún rol
-- nuevo ni función SECURITY DEFINER: el consumidor que la escribe corre DENTRO
-- de `withTenant` con el rol de aplicación, como cualquier request. El servicio
-- de IA no toca la base de datos (decisión 1 del ADR).
-- =============================================================================

-- CreateTable
CREATE TABLE "ticket_triages" (
    "ticket_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "category" TEXT NOT NULL,
    "suggested_priority" "ticket_priority" NOT NULL,
    "sentiment" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "prompt_version" TEXT NOT NULL,
    "latency_ms" INTEGER NOT NULL,
    "input_tokens" INTEGER,
    "output_tokens" INTEGER,
    "triaged_at" TIMESTAMP(3) NOT NULL,

    -- Una sugerencia por ticket. Es además la garantía de idempotencia al guardar.
    CONSTRAINT "ticket_triages_pkey" PRIMARY KEY ("ticket_id")
);

-- CreateIndex
CREATE INDEX "ticket_triages_tenant_id_category_idx" ON "ticket_triages"("tenant_id", "category");

-- AddForeignKey
ALTER TABLE "ticket_triages" ADD CONSTRAINT "ticket_triages_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_triages" ADD CONSTRAINT "ticket_triages_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- =============================================================================
-- Row-Level Security (ADR-0010), igual que el resto del esquema.
-- =============================================================================

-- Mismos privilegios que el resto de tablas de ticketing. La aplicación nunca
-- borra una sugerencia (desaparece en cascada con su ticket o su tenant).
GRANT SELECT, INSERT, UPDATE, DELETE ON "ticket_triages" TO helpdesk_app;

ALTER TABLE "ticket_triages" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ticket_triages" FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "ticket_triages"
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
