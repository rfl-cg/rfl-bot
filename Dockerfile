# syntax=docker/dockerfile:1
# Uma imagem por alvo: api, worker, whatsapp, runner e migrate.
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
RUN pnpm turbo run build \
  --filter=@rfl-bot/api --filter=@rfl-bot/worker --filter=@rfl-bot/runner --filter=@rfl-bot/whatsapp
# Copia cada app só com as dependências de produção.
RUN for app in api worker runner whatsapp; do \
      pnpm deploy --filter=@rfl-bot/$app --prod --legacy /out/$app || exit 1; \
    done \
  # O banco leva o CLI do Prisma (dependência de desenvolvimento) para as migrations.
  && pnpm deploy --filter=@rfl-bot/db --legacy /out/db

# ─── Migrate: aplica as migrations do banco e sai ───────────────────────────
FROM ${NODE_IMAGE} AS migrate
# OpenSSL: o motor de migrations do Prisma precisa dele.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build --chown=node:node /out/db ./
USER node
CMD ["node_modules/.bin/prisma", "migrate", "deploy"]

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

# ─── Gateway do WhatsApp ────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS whatsapp
ARG APP_VERSION=dev
ENV NODE_ENV=production \
    APP_VERSION=${APP_VERSION} \
    WHATSAPP_AUTH_DIR=/data/whatsapp
WORKDIR /app
# A sessão do WhatsApp fica num volume em /data/whatsapp.
RUN mkdir -p /data/whatsapp && chown -R node:node /data
COPY --from=build --chown=node:node /out/whatsapp ./
USER node
CMD ["node", "--enable-source-maps", "dist/index.js"]

# ─── Runner: o "computador dos bots" ────────────────────────────────────────
# Roda os CLIs dos provedores (o do Claude vem com o Agent SDK).
# Não recebe a senha do banco, do Redis nem a ENCRYPTION_KEY.
FROM ${NODE_IMAGE} AS runner
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /data && chown node:node /data
ARG APP_VERSION=dev
ENV NODE_ENV=production \
    APP_VERSION=${APP_VERSION} \
    RUNNER_DATA_DIR=/data \
    RUNNER_PORT=4000
WORKDIR /app
COPY --from=build --chown=node:node /out/runner ./
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:4000/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "--enable-source-maps", "dist/index.js"]
