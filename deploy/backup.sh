#!/usr/bin/env bash
# Backup do Postgres. Guarda 7 dias em deploy/backups/.
# Agende no cron da VPS (crontab -e):
#   0 3 * * * /opt/rfl-bot/deploy/backup.sh >> /var/log/rfl-bot-backup.log 2>&1
# Copie também para fora da VPS (ex.: rclone para Google Drive ou S3).
set -euo pipefail
cd "$(dirname "$0")"

mkdir -p backups
file="backups/rflbot-$(date +%Y%m%d-%H%M%S).sql.gz"

docker compose exec -T postgres pg_dump -U rflbot -d rflbot --no-owner | gzip > "$file.tmp"
mv "$file.tmp" "$file"
find backups -name 'rflbot-*.sql.gz' -mtime +7 -delete

echo "$(date -Is) backup ok: $file ($(du -h "$file" | cut -f1))"
