# Multi-stage build. pnpm 11 vía corepack, Node 24 (ver CLAUDE.md).
# Etapas: deps (todas) -> build -> prod-deps (solo runtime) -> runner.

# ---- base: habilita pnpm una sola vez ----
FROM node:24-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

# ---- deps: instala TODAS las dependencias (incluye dev, para poder buildear) ----
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ---- build: compila TypeScript -> dist ----
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm build

# ---- prod-deps: solo dependencias de runtime ----
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --prod --frozen-lockfile

# ---- runner: imagen final mínima, usuario no-root ----
FROM node:24-alpine AS runner
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# node:alpine ya trae el usuario `node` sin privilegios.
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
