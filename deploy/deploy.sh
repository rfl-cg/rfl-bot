#!/usr/bin/env bash
# Atualiza a VPS com a última versão da main. Usado pelo GitHub Actions (deploy.yml).
set -euo pipefail
cd "$(dirname "$0")/.."

git pull --ff-only origin main
export APP_VERSION="$(git rev-parse --short HEAD)"

cd deploy
docker compose up -d --build --remove-orphans
# Só limpa imagens antigas do RFL Bot: a VPS tem outros apps.
docker image prune -f --filter "label=com.docker.compose.project=rfl-bot"

echo "deploy ok: $APP_VERSION"
