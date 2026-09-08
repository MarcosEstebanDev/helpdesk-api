-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "family_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "rotated_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_tokens_tenant_id_token_hash_idx" ON "refresh_tokens"("tenant_id", "token_hash");

-- CreateIndex
CREATE INDEX "refresh_tokens_tenant_id_family_id_idx" ON "refresh_tokens"("tenant_id", "family_id");

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- =============================================================================
-- RLS de refresh_tokens (mismo patrón que init_auth_tenancy, ADR-0010).
-- =============================================================================

-- El ALTER DEFAULT PRIVILEGES de la migración anterior solo aplica a objetos
-- creados por el rol `helpdesk`; hacemos el GRANT explícito para no depender de
-- qué rol corre esta migración.
GRANT SELECT, INSERT, UPDATE, DELETE ON "refresh_tokens" TO helpdesk_app;

ALTER TABLE "refresh_tokens" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "refresh_tokens" FORCE ROW LEVEL SECURITY;

-- Fail-closed, igual que el resto: NULLIF colapsa "sin setear" y "reseteado a ''"
-- a NULL, y ninguna fila matchea.
CREATE POLICY tenant_isolation ON "refresh_tokens"
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- =============================================================================
-- Resolución slug -> tenant_id para el login (ADR-0012).
--
-- Problema: el login recibe `organizationSlug` y todavía NO conoce el tenant, así
-- que no puede fijar `app.current_tenant` antes de la consulta. Pero `organizations`
-- tiene FORCE ROW LEVEL SECURITY, que —a diferencia de ENABLE— aplica TAMBIÉN al
-- dueño de la tabla. Una función SECURITY DEFINER común, propiedad del owner,
-- seguiría filtrada por `tenant_isolation` y devolvería siempre NULL.
--
-- Solución de privilegio mínimo: un rol dedicado, NOLOGIN y SIN BYPASSRLS, que solo
-- puede leer las columnas (id, slug) de `organizations` gracias a una policy propia.
-- La función SECURITY DEFINER es propiedad suya, y solo `helpdesk_app` puede
-- ejecutarla. Aunque la función se viera comprometida, lo máximo que expone es el
-- mapeo slug -> id (que el cliente ya provee en el login); no abre el resto de las
-- columnas ni las demás tablas, y no depende de que el owner sea superusuario.
-- =============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'helpdesk_slug_resolver') THEN
    CREATE ROLE helpdesk_slug_resolver NOLOGIN;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO helpdesk_slug_resolver;
-- Privilegio a nivel de COLUMNA: ni siquiera puede ver `name` o los timestamps.
GRANT SELECT (id, slug) ON "organizations" TO helpdesk_slug_resolver;

-- Sin esta policy, el rol quedaría bloqueado por RLS igual que cualquier otro:
-- es la única excepción, acotada a SELECT y a este rol.
CREATE POLICY slug_lookup ON "organizations"
  FOR SELECT TO helpdesk_slug_resolver
  USING (true);

CREATE OR REPLACE FUNCTION iam_resolve_tenant_by_slug(p_slug text)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
-- search_path fijo: evita que un search_path del caller secuestre la resolución
-- de nombres dentro de una función definer (CVE clásico de Postgres).
SET search_path = pg_catalog, public
AS $$
  SELECT id FROM public.organizations WHERE slug = p_slug;
$$;

-- El owner de la función es quien define sus privilegios efectivos: ese es el
-- punto de todo el ADR. Requiere que el rol de migración sea miembro del rol.
GRANT helpdesk_slug_resolver TO CURRENT_USER;
ALTER FUNCTION iam_resolve_tenant_by_slug(text) OWNER TO helpdesk_slug_resolver;

REVOKE ALL ON FUNCTION iam_resolve_tenant_by_slug(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION iam_resolve_tenant_by_slug(text) TO helpdesk_app;
