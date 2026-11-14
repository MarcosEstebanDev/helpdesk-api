-- Notas internas (ADR-0028).
--
-- Los comentarios que ya existen eran todos conversación con el cliente: el
-- DEFAULT los deja como PUBLIC en el mismo ALTER, sin un UPDATE aparte.
-- `comments` ya tiene RLS ENABLE + FORCE y `helpdesk_app` ya tiene DML sobre la
-- tabla entera, así que la columna nueva no necesita GRANT propio.
CREATE TYPE "comment_visibility" AS ENUM ('PUBLIC', 'INTERNAL');

ALTER TABLE "comments"
  ADD COLUMN "visibility" "comment_visibility" NOT NULL DEFAULT 'PUBLIC';
