#!/usr/bin/env bash
set -euo pipefail
# Protect credentials and CA keys from the moment the archive is created.
umask 077
# Usage: DATA_ROOT=/srv/mangasee/data ./scripts/backup.sh /srv/backups
: "${DATA_ROOT:?Set DATA_ROOT to the local data directory}"
backup_dir="${1:?Supply a backup destination outside DATA_ROOT}"
mkdir -p "$backup_dir"
backup_dir="$(cd "$backup_dir" && pwd)"
data_dir="$(cd "$DATA_ROOT" && pwd)"
case "$backup_dir/" in "$data_dir/"*) echo 'Backup destination must be outside DATA_ROOT' >&2; exit 1;; esac
archive="$backup_dir/mangasee-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
docker compose stop app komga caddy
trap 'docker compose start komga app caddy' EXIT
# Stopped services give a consistent copy including SQLite WAL files and Caddy CA.
tar -czf "$archive" -C "$data_dir" .
chmod 600 "$archive"
echo "Created $archive"
