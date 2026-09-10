# Multi-stage build. pnpm 11 vía corepack, Node 24 (ver CLAUDE.md).
# Etapas: deps (todas + cliente Prisma) -> build -> prod-deps -> runner.
#
# `build` se usa también como imagen de tareas puntuales (migraciones, seed) en
# infra/docker-compose.demo.yml: es la única etapa que tiene el CLI de Prisma y
# los scripts de desarrollo. Así la imagen que se despliega no carga con ellos.

# ---- base: habilita pnpm una sola vez ----
FROM node:24-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

# ---- deps: instala TODAS las dependencias (incluye dev, para poder buildear) ----
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# El schema entra ANTES de instalar: el postinstall de @prisma/client lo busca, y
# sin él el cliente no se genera. Ese fue el motivo real de que esta imagen
# estuviera rota desde que Prisma llegó al proyecto.
COPY prisma ./prisma
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile
# Explícito y no confiado al postinstall: `prisma generate` es lo que convierte
# schema.prisma en los tipos que importa TODO el código de persistencia.
RUN pnpm prisma generate

# ---- build: compila TypeScript -> dist ----
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm build

# ---- prod-deps: poda las dependencias de desarrollo ----
# Se parte de `deps` (no de una instalación limpia) a propósito: el cliente de
# Prisma ya generado vive dentro de node_modules/.pnpm/@prisma+client@<hash>/, y
# regenerarlo aquí exigiría el CLI de Prisma, que es una dependencia de
# desarrollo. `prune` respeta @prisma/client porque es dependencia de producción,
# así que el cliente sobrevive a la poda.
FROM deps AS prod-deps
RUN pnpm prune --prod

# ---- runner: imagen final mínima, usuario no-root ----
FROM node:24-alpine AS runner
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# El schema viaja con la imagen para que `prisma migrate diff` y las
# herramientas de diagnóstico puedan usarse contra un contenedor en marcha.
COPY prisma ./prisma
# Red de seguridad: si el cliente de Prisma no quedó generado, @prisma/client
# lanza al importarse. Mejor que falle AQUÍ, en el build, y no al arrancar el
# contenedor en un despliegue.
RUN node -e "const {PrismaClient} = require('@prisma/client'); if (typeof PrismaClient !== 'function') throw new Error('cliente de Prisma no generado'); console.log('cliente de Prisma OK');"
# node:alpine ya trae el usuario `node` sin privilegios.
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
