#!/usr/bin/env bash
# Updates application code only; OS, Node and Komga upgrades are separate operations.
set -Eeuo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
umask 027
[[ $EUID -eq 0 && -f /.mangasee-lxc ]] || { echo 'Run inside the managed MangaSee LXC as root' >&2; exit 1; }
ARCHIVE="$(realpath "${1:?Usage: mangasee-update /root/mangasee.tar.gz}")"
[[ -f "$ARCHIVE" ]] || exit 2
exec 9>/run/lock/mangasee-deploy.lock
flock -n 9 || { echo 'Another backup or update is running' >&2; exit 1; }
/usr/local/sbin/mangasee-check-library "$(cat /etc/mangasee/library-path 2>/dev/null || printf /library)"
RELEASE_ID="$(date -u +%Y%m%dT%H%M%SZ)-$(sha256sum "$ARCHIVE" | cut -c1-12)-$$"
RELEASE="/opt/mangasee/releases/$RELEASE_ID"
OLD_RELEASE="$(readlink -f /opt/mangasee/current || true)"
BACKUP="/var/backups/mangasee/update-$RELEASE_ID"
STOPPED=no
SNAPSHOT_READY=no
SWITCHED=no
cleanup() {
  code=$?
  trap - EXIT
  if (( code != 0 )); then
    echo 'Update failed; retaining staged source and logs for inspection.' >&2
    if [[ "$STOPPED" == yes ]]; then
      systemctl stop mangasee || true
      if [[ "$SWITCHED" == yes ]]; then
        # Restore the pre-migration database, retaining the failed state for diagnosis.
        if [[ "$SNAPSHOT_READY" == yes ]]; then
          mv /var/lib/mangasee "$BACKUP/failed-data"
          cp -a "$BACKUP/data" /var/lib/mangasee
        fi
        if [[ -n "$OLD_RELEASE" ]]; then
          ln -sfn "$OLD_RELEASE" /opt/mangasee/current.next
          mv -Tf /opt/mangasee/current.next /opt/mangasee/current
        else
          rm -f /opt/mangasee/current
        fi
      fi
      if [[ -n "$OLD_RELEASE" ]]; then
        systemctl start mangasee || echo 'Previous service could not restart; inspect journalctl -u mangasee.' >&2
      fi
    fi
  fi
  exit "$code"
}
trap cleanup EXIT
install -d -m 0755 "$RELEASE"
python3 /usr/local/lib/mangasee-extract.py "$ARCHIVE" "$RELEASE"
[[ "$(/usr/local/bin/node --version)" == "v$(cat "$RELEASE/.nvmrc")" ]] || { echo 'Bundle needs another Node version; review runtime upgrade first.' >&2; exit 1; }
chown -R mangasee:mangasee "$RELEASE"
chmod -R u+rwX,go+rX "$RELEASE"
install -d -m 0750 -o mangasee -g mangasee /var/cache/mangasee
# Build without root privileges while the old application continues serving.
runuser -u mangasee -- env PATH="$PATH" npm_config_cache=/var/cache/mangasee /usr/local/bin/npm --prefix "$RELEASE" ci --no-audit --no-fund
runuser -u mangasee -- env PATH="$PATH" npm_config_cache=/var/cache/mangasee /usr/local/bin/npm --prefix "$RELEASE" run build
[[ -f "$RELEASE/dist/index.html" && -f "$RELEASE/dist-server/server/index.js" ]] || { echo 'Build output missing' >&2; exit 1; }
chown -R root:root "$RELEASE"
# npm/build inherit umask 027; after ownership changes, the service still needs
# to traverse directories and read new dependencies and compiled output.
chmod -R u+rwX,go+rX,go-w "$RELEASE"
install -d -m 0700 "$BACKUP"
printf '%s\n' "$OLD_RELEASE" >"$BACKUP/previous-release"
STOPPED=yes
systemctl stop mangasee
cp -a /var/lib/mangasee "$BACKUP/data"
SNAPSHOT_READY=yes
ln -sfn "$RELEASE" /opt/mangasee/current.next
# Set before rename so even an interrupted switch is rolled back.
SWITCHED=yes
mv -Tf /opt/mangasee/current.next /opt/mangasee/current
systemctl start mangasee
READY=no
for (( attempt=0; attempt<30; attempt++ )); do
  if curl -fsS --max-time 3 http://127.0.0.1:3000/api/health 2>/dev/null | python3 -c 'import json,sys; assert json.load(sys.stdin)["ok"] is True' 2>/dev/null; then
    READY=yes; break
  fi
  sleep 2
done
[[ "$READY" == yes ]] || { echo 'New application failed its health check' >&2; exit 1; }
STOPPED=no
printf 'Application updated: %s\nPre-update database: %s\n' "$RELEASE_ID" "$BACKUP"
