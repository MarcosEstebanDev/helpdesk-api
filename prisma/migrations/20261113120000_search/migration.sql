-- =============================================================================
-- Búsqueda de texto completo (ADR-0032).
--
-- Postgres en español, sin distinguir acentos. Las columnas `search_vector` son
-- GENERADAS: Postgres las mantiene solas en cada INSERT/UPDATE, sin triggers ni
-- código en la aplicación que pueda olvidarse de actualizarlas.
-- =============================================================================

-- `unaccent` es una extensión "trusted" desde Postgres 13: la crea el dueño de
-- la base sin superusuario (sirve igual en Neon).
CREATE EXTENSION IF NOT EXISTS unaccent;

-- `unaccent()` es STABLE (depende del diccionario configurado) y una columna
-- generada exige IMMUTABLE. El envoltorio fija diccionario y esquema, que es lo
-- que la hace segura de marcar como inmutable.
CREATE OR REPLACE FUNCTION helpdesk_unaccent(texto text)
  RETURNS text
  LANGUAGE sql
  IMMUTABLE PARALLEL SAFE STRICT
AS $$ SELECT public.unaccent('public.unaccent'::regdictionary, texto) $$;

-- Asunto con más peso que la descripción.
ALTER TABLE "tickets" ADD COLUMN "search_vector" tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('spanish', helpdesk_unaccent(coalesce("subject", ''))), 'A') ||
    setweight(to_tsvector('spanish', helpdesk_unaccent(coalesce("description", ''))), 'B')
  ) STORED;

ALTER TABLE "comments" ADD COLUMN "search_vector" tsvector
  GENERATED ALWAYS AS (
    to_tsvector('spanish', helpdesk_unaccent(coalesce("body", '')))
  ) STORED;

-- CreateIndex
CREATE INDEX "tickets_search_vector_idx" ON "tickets" USING GIN ("search_vector");

-- CreateIndex
CREATE INDEX "comments_search_vector_idx" ON "comments" USING GIN ("search_vector");
