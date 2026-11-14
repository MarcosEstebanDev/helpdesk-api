-- =============================================================================
-- Horario laboral (ADR-0034).
--
-- Una fila por organización en `business_calendars` (sin fila = valores por
-- defecto del dominio: L–V 08:00–18:00, Argentina; no hay backfill) y las
-- excepciones por fecha LOCAL en `business_calendar_exceptions`.
-- =============================================================================

-- CreateEnum
CREATE TYPE "BusinessCalendarMode" AS ENUM ('BUSINESS_HOURS', 'TWENTY_FOUR_SEVEN');

-- CreateTable
CREATE TABLE "business_calendars" (
    "tenant_id" UUID NOT NULL,
    "mode" "BusinessCalendarMode" NOT NULL,
    "time_zone" TEXT NOT NULL,
    "weekdays" SMALLINT[],
    "opens_at_minute" SMALLINT NOT NULL,
    "closes_at_minute" SMALLINT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "business_calendars_pkey" PRIMARY KEY ("tenant_id")
);

-- CreateTable
CREATE TABLE "business_calendar_exceptions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "working" BOOLEAN NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "business_calendar_exceptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "business_calendar_exceptions_tenant_id_date_key" ON "business_calendar_exceptions"("tenant_id", "date");

-- AddForeignKey
ALTER TABLE "business_calendars" ADD CONSTRAINT "business_calendars_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_calendar_exceptions" ADD CONSTRAINT "business_calendar_exceptions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- =============================================================================
-- Row-Level Security (ADR-0010), igual que el resto del esquema. Solo las lee
-- y escribe `helpdesk_app` dentro de `withTenant`: ni el barrido ni el
-- publicador las necesitan (el calendario se pide en los casos de uso).
-- =============================================================================

GRANT SELECT, INSERT, UPDATE, DELETE ON "business_calendars" TO helpdesk_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "business_calendar_exceptions" TO helpdesk_app;

ALTER TABLE "business_calendars" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "business_calendars" FORCE  ROW LEVEL SECURITY;
ALTER TABLE "business_calendar_exceptions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "business_calendar_exceptions" FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "business_calendars"
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

CREATE POLICY tenant_isolation ON "business_calendar_exceptions"
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
