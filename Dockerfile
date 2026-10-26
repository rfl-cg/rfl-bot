# syntax=docker/dockerfile:1
# Uma imagem por alvo: api, worker e migrate.
#   docker build --target api -t rfl-bot-api .

ARG NODE_IMAGE=node:24.22.1-bookworm-slim

# ─── Build: instala tudo e compila ──────────────────────────────────────────
FROM ${NODE_IMAGE} AS build
# OpenSSL: o motor de migrations do Prisma precisa dele.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    TURBO_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /repo

COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store \
  && pnpm install --frozen-lockfile
RUN pnpm turbo run build --filter=@rfl-bot/api --filter=@rfl-bot/worker
# Copia cada app só com as dependências de produção.
RUN pnpm deploy --filter=@rfl-bot/api --prod --legacy /out/api \
  && pnpm deploy --filter=@rfl-bot/worker --prod --legacy /out/worker

# ─── Migrate: aplica as migrations do banco e sai ───────────────────────────
FROM build AS migrate
CMD ["pnpm", "--filter", "@rfl-bot/db", "migrate:deploy"]

# ─── Base de execução ───────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS runtime
ARG APP_VERSION=dev
ENV NODE_ENV=production \
    APP_VERSION=${APP_VERSION}
WORKDIR /app
USER node

# ─── API ────────────────────────────────────────────────────────────────────
FROM runtime AS api
COPY --from=build --chown=node:node /out/api ./
ENV API_PORT=3000
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "--enable-source-maps", "dist/index.js"]

# ─── Worker ─────────────────────────────────────────────────────────────────
FROM runtime AS worker
COPY --from=build --chown=node:node /out/worker ./
CMD ["node", "--enable-source-maps", "dist/index.js"]
