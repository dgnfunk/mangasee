#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
[[ $EUID -eq 0 && -f /.mangasee-lxc ]] || { echo 'Run inside the managed MangaSee LXC as root' >&2; exit 1; }
exec 9>/run/lock/mangasee-deploy.lock
flock -n 9 || { echo 'Another backup or update is running' >&2; exit 1; }
BACKUP="/var/backups/mangasee/full-$(date -u +%Y%m%dT%H%M%SZ)-$$"
install -d -m 0700 "$BACKUP"
ACTIVE=()
for service in mangasee komga caddy; do
  if systemctl is-active --quiet "$service"; then ACTIVE+=("$service"); fi
done
restart() {
  code=$?
  trap - EXIT
  for service in "${ACTIVE[@]}"; do systemctl start "$service" || code=1; done
  exit "$code"
}
trap restart EXIT
systemctl stop mangasee komga caddy
readlink -f /opt/mangasee/current >"$BACKUP/release-path"
# Includes secrets and the private CA: keep this archive private. Library originals are excluded.
tar -czf "$BACKUP/state.tar.gz.partial" -C / \
  etc/mangasee etc/caddy etc/systemd/system/mangasee.service etc/systemd/system/komga.service \
  var/lib/mangasee var/lib/komga var/lib/caddy
mv "$BACKUP/state.tar.gz.partial" "$BACKUP/state.tar.gz"
sha256sum "$BACKUP/state.tar.gz" >"$BACKUP/state.tar.gz.sha256"
printf 'Backup: %s\nCopy it off the LXC; it contains credentials and the private HTTPS CA.\n' "$BACKUP"
