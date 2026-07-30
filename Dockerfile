# ── Base ──────────────────────────────────────────────────────────────────────
FROM node:26.5.0-slim AS base
# `ca-certificates` is required by the Go-based `vp` binary for HTTPS;
# `node:26.5.0-slim` does not ship it.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
ENV PNPM_HOME="/pnpm" PATH="/pnpm:$PATH"
# Corepack is no longer distributed with Node 25+, so install pnpm directly.
# Keep in step with `packageManager` in the root package.json.
RUN npm install -g pnpm@11.5.0
# Vite+ is the canonical task runner — installed globally so `vp run` works
# in build stages without relying on `pnpm exec` resolution. Pinned to the
# catalog's vite-plus version so image builds can't drift onto a newer
# toolchain than the lockfile was resolved against.
RUN npm install -g vite-plus@0.2.6
WORKDIR /app

# ── Dependencies ─────────────────────────────────────────────────────────────
FROM base AS deps

# All workspace package.json files (and the root vite.config.ts that defines
# top-level run.tasks + shared lint/fmt rules) are needed for vp's workspace
# resolution and for pnpm's catalog/dep graph.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml vite.config.ts ./
COPY services/api-hono/package.json services/api-hono/
COPY apps/web/package.json apps/web/
COPY tests/e2e/package.json tests/e2e/

RUN vp install --frozen-lockfile --ignore-scripts

# ── Build API ────────────────────────────────────────────────────────────────
FROM deps AS build-api

COPY services/api-hono/ services/api-hono/

# `vp run -F @libris/api-hono build` runs the task graph defined in
# services/api-hono/vite.config.ts: generate:version → build:spec → vp pack +
# cp migrations into dist/.
RUN vp run -F @libris/api-hono build

# ── Build Web ────────────────────────────────────────────────────────────────
FROM deps AS build-web

# api-hono's vite.config.ts + scripts/ + src/ are needed because apps/web's
# build task declares a cross-package dependsOn on @libris/api-hono#generate:version,
# and vue-tsc traverses @libris/api-hono/client → src/routes/* into the api-hono
# source tree.
COPY services/api-hono/vite.config.ts services/api-hono/
COPY services/api-hono/src/ services/api-hono/src/
COPY services/api-hono/scripts/ services/api-hono/scripts/

# Web app source
COPY apps/web/ apps/web/

# `vp run -F @libris/web build` runs: @libris/api-hono#generate:version →
# @libris/web#type-check (vue-tsc --build) → @libris/web#build (vp build).
RUN vp run -F @libris/web build

# ── Runner ───────────────────────────────────────────────────────────────────
FROM node:26.5.0-slim

WORKDIR /app

# tsdown output
COPY --from=build-api --chown=node:node /app/services/api-hono/dist dist
# migrations alongside the app (default MIGRATIONS_PATH=./migrations)
COPY --from=build-api --chown=node:node /app/services/api-hono/dist/migrations migrations
# SPA static files — served by Hono's serveStatic from ./public
COPY --from=build-web --chown=node:node /app/apps/web/dist public

# Data directories — created as root, ownership set for node user (UID 1000).
# Mount volumes here; ensure the host directories are writable by UID 1000.
RUN mkdir -p /data/inbox /data/library && chown -R node:node /data

ENV NODE_ENV=production

USER node
EXPOSE 3000

CMD ["node", "dist/index.mjs"]
