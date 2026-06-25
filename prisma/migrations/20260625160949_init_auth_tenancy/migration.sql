-- CreateEnum
CREATE TYPE "role" AS ENUM ('ADMIN', 'AGENT', 'VIEWER');

-- CreateTable
CREATE TABLE "organizations" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memberships" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "role" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memberships_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "organizations_slug_key" ON "organizations"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "users_tenant_id_email_key" ON "users"("tenant_id", "email");

-- CreateIndex
CREATE UNIQUE INDEX "memberships_tenant_id_user_id_key" ON "memberships"("tenant_id", "user_id");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- =============================================================================
-- Row-Level Security multi-tenant (ADR-0010). Corre con el rol owner/superusuario
-- (MIGRATION_DATABASE_URL). NO lo modela Prisma: es SQL crudo a propósito.
-- =============================================================================

-- 1) Rol de APLICACIÓN restringido: LOGIN, SIN BYPASSRLS y NO dueño de las tablas.
--    Idempotente para ser seguro en re-ejecuciones / shadow DB.
--    Credencial local de portfolio; en producción se provisiona por IaC.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'helpdesk_app') THEN
    CREATE ROLE helpdesk_app LOGIN PASSWORD 'helpdesk_app';
  END IF;
END
$$;

-- 2) Privilegios mínimos: DML sobre las tablas actuales + futuras. Sin DDL.
GRANT USAGE ON SCHEMA public TO helpdesk_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO helpdesk_app;
ALTER DEFAULT PRIVILEGES FOR ROLE helpdesk IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO helpdesk_app;

-- 3) Activar RLS y FORZARLA (aplica incluso al dueño de la tabla).
ALTER TABLE "organizations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organizations" FORCE ROW LEVEL SECURITY;
ALTER TABLE "users"         ENABLE ROW LEVEL SECURITY;
ALTER TABLE "users"         FORCE ROW LEVEL SECURITY;
ALTER TABLE "memberships"   ENABLE ROW LEVEL SECURITY;
ALTER TABLE "memberships"   FORCE ROW LEVEL SECURITY;

-- 4) Policies fail-closed. Usamos NULLIF(current_setting(...), '') porque un GUC de
--    namespace propio, una vez tocado en la sesión, al resetearse vuelve a cadena
--    VACÍA (no NULL); ''::uuid lanzaría 22P02. Con NULLIF, tanto "sin setear" como
--    "reseteado a ''" colapsan a NULL => la comparación no matchea ninguna fila.
--    organizations se aísla por su propio id; las hijas por tenant_id.
CREATE POLICY tenant_isolation ON "organizations"
  USING (id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

CREATE POLICY tenant_isolation ON "users"
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

CREATE POLICY tenant_isolation ON "memberships"
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
