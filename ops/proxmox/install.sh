#!/usr/bin/env bash
# MANGASEE_LXC_INSTALLER — only invoked inside this installer's dedicated LXC.
set -Eeuo pipefail
# pct exec can provide a minimal PATH without /usr/local/{sbin,bin}.
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
umask 027
[[ $EUID -eq 0 ]] || { echo 'Run as root inside the LXC' >&2; exit 1; }
ARCHIVE="${1:?Source archive required}"
SITE_ADDRESS="${2:?Site DNS hostname required}"
LIBRARY_PATH="${3:-/library}"
CREATE_LIBRARY_DIR="${4:-no}"
[[ "$CREATE_LIBRARY_DIR" == yes || "$CREATE_LIBRARY_DIR" == no ]] || { echo 'CREATE_LIBRARY_DIR must be yes or no' >&2; exit 2; }
[[ "$LIBRARY_PATH" =~ ^(/[a-zA-Z0-9_-][a-zA-Z0-9_.-]*)+$ ]] || { echo 'Invalid library path' >&2; exit 2; }
[[ "$SITE_ADDRESS" =~ ^[a-z0-9][a-z0-9.-]*[a-z0-9]$ ]] || exit 2
source /etc/os-release
[[ "$ID" == debian && "$VERSION_ID" == 13 ]] || { echo 'Debian 13 is required' >&2; exit 1; }
[[ -f /.mangasee-lxc || ! -e /etc/mangasee ]] || { echo 'Unexpected existing installation' >&2; exit 1; }
touch /.mangasee-lxc
export DEBIAN_FRONTEND=noninteractive
if ! runuser -u _apt -- test -r /etc/resolv.conf; then
  echo '[ERROR] APT download user _apt cannot read /etc/resolv.conf. Inspect its permissions, symlink target and parent directories before resuming.' >&2
  exit 1
fi
for domain in deb.debian.org security.debian.org; do
  if ! timeout 15 getent ahosts "$domain" >/dev/null; then
    echo "[ERROR] Container DNS cannot resolve $domain. Check its IP address, default route and /etc/resolv.conf; configure a reachable DNS server in Proxmox, then resume." >&2
    exit 1
  fi
  if ! timeout 15 runuser -u _apt -- getent ahosts "$domain" >/dev/null; then
    echo "[ERROR] Root resolved $domain, but APT download user _apt could not. Check resolver permissions and container network/security policy; do not disable APT sandboxing." >&2
    exit 1
  fi
done
# apt-get update normally permits transient fetch failures and reuses stale lists.
# Fail before package installation if any repository refresh failed.
if ! apt-get --error-on=any -o Acquire::Retries=2 -o Acquire::http::Timeout=20 -o Acquire::https::Timeout=20 update; then
  echo '[ERROR] Package indexes could not be refreshed. Fix the DNS/network or repository error above, then resume. Dependency installation has not started.' >&2
  exit 1
fi
apt-get install -y --no-install-recommends ca-certificates curl python3 xz-utils default-jre-headless caddy openssl
for account in mangasee komga; do
  id "$account" >/dev/null 2>&1 || useradd --system --create-home --home-dir "/var/lib/$account" --shell /usr/sbin/nologin "$account"
done
install -d -m 0750 -o mangasee -g mangasee /var/lib/mangasee
install -d -m 0750 -o komga -g komga /var/lib/komga
install -d -m 0700 /etc/mangasee /var/backups/mangasee
install -d -m 0755 /opt/mangasee/releases /opt/komga
if [[ -f /etc/mangasee/site-address ]]; then
  [[ "$(cat /etc/mangasee/site-address)" == "$SITE_ADDRESS" ]] || { echo 'Refusing to change existing site origin during resume' >&2; exit 1; }
else printf '%s\n' "$SITE_ADDRESS" >/etc/mangasee/site-address; fi
if [[ -f /etc/mangasee/library-path ]]; then
  [[ "$(cat /etc/mangasee/library-path)" == "$LIBRARY_PATH" ]] || { echo 'Keep the existing library path on resume; add additional roots in Komga.' >&2; exit 1; }
else printf '%s\n' "$LIBRARY_PATH" >/etc/mangasee/library-path; fi
TEMP_DIR="$(mktemp -d)"
trap 'rm -rf -- "$TEMP_DIR"' EXIT
# Validate archive before extracting its installer helpers.
python3 - "$ARCHIVE" "$TEMP_DIR/source" <<'PY'
import pathlib, sys, tarfile
with tarfile.open(sys.argv[1]) as archive:
    for item in archive.getmembers():
        p=pathlib.PurePosixPath(item.name)
        if p.is_absolute() or '..' in p.parts or not (item.isfile() or item.isdir()):
            raise SystemExit('Unsafe source archive')
    archive.extractall(sys.argv[2], filter='data')
PY
SOURCE="$TEMP_DIR/source"
[[ -f "$SOURCE/package-lock.json" && -f "$SOURCE/ops/proxmox/update.sh" ]] || { echo 'Incomplete source bundle' >&2; exit 1; }
install -m 0755 "$SOURCE/ops/proxmox/check-library.sh" /usr/local/sbin/mangasee-check-library
# Only an explicit first-install request may initialize an empty local library.
# Existing folders and previously registered libraries retain their outage guard.
if [[ "$CREATE_LIBRARY_DIR" == yes ]]; then
  python3 - "$LIBRARY_PATH" /etc/mangasee /var/lib/mangasee/mangasee.sqlite <<'INIT_LIBRARY'
import os
from pathlib import Path
import sys

folder, config, database = map(Path, sys.argv[1:])
for path in [*folder.parents, folder]:
    if path.is_symlink():
        raise SystemExit(f'Refusing to initialize a library through a symlink: {path}')
if folder.exists():
    if not folder.is_dir():
        raise SystemExit(f'Library path exists but is not a folder: {folder}')
    print(f'Library folder already exists; preserving its contents and permissions: {folder}')
elif (config / 'credentials.json').exists() or (config / 'install-complete').exists() or database.exists():
    raise SystemExit('Library was already registered. Restore its folder/mount; refusing to create an empty replacement.')
else:
    os.umask(0o022)
    # mkdir each missing component with readable/traversable permissions. Do not
    # chmod existing parents or recursively change permissions on source files.
    for path in [*reversed(folder.parents), folder]:
        if not path.exists():
            path.mkdir(mode=0o755)
    marker = folder / '.mangasee-library'
    with os.fdopen(os.open(marker, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644), 'w') as handle:
        handle.write('mangasee-library\n')
    print(f'Created empty local library: {folder}. Add your books there before scanning.')
INIT_LIBRARY
fi
runuser -u mangasee -- /usr/local/sbin/mangasee-check-library "$LIBRARY_PATH"
runuser -u komga -- /usr/local/sbin/mangasee-check-library "$LIBRARY_PATH"
NODE_VERSION="$(cat "$SOURCE/.nvmrc")"
[[ "$NODE_VERSION" =~ ^24\.[0-9]+\.[0-9]+$ ]] || { echo 'Expected a pinned Node 24 release' >&2; exit 1; }
case "$(dpkg --print-architecture)" in amd64) NODE_ARCH=x64;; arm64) NODE_ARCH=arm64;; *) exit 1;; esac
NODE_DIR="/usr/local/lib/nodejs/node-v$NODE_VERSION-linux-$NODE_ARCH"
if [[ ! -x "$NODE_DIR/bin/node" ]]; then
  FILE="node-v$NODE_VERSION-linux-$NODE_ARCH.tar.xz"
  curl -fsSL --retry 3 "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" -o "$TEMP_DIR/SHASUMS256.txt"
  curl -fsSL --retry 3 "https://nodejs.org/dist/v$NODE_VERSION/$FILE" -o "$TEMP_DIR/$FILE"
  (cd "$TEMP_DIR"; awk -v file="$FILE" '$2==file {print;found=1} END{if(!found)exit 1}' SHASUMS256.txt > selected.sha256; sha256sum --check selected.sha256)
  install -d -m 0755 /usr/local/lib/nodejs
  tar -xJf "$TEMP_DIR/$FILE" -C /usr/local/lib/nodejs
  chmod -R a+rX "$NODE_DIR"
fi
for bin in node npm npx; do ln -sfn "$NODE_DIR/bin/$bin" "/usr/local/bin/$bin"; done
JAR=/opt/komga/komga-1.22.0.jar
if [[ ! -f "$JAR" ]]; then
  curl -fsSL --retry 3 https://github.com/gotson/komga/releases/download/1.22.0/komga-1.22.0.jar -o "$TEMP_DIR/komga.jar"
  printf '%s  %s\n' '6ee73bf422000de663432704ca64e6b24443dbe698ea741e71fd10a950c4815f' "$TEMP_DIR/komga.jar" | sha256sum --check -
  python3 - "$TEMP_DIR/komga.jar" <<'PY'
import sys,zipfile
with zipfile.ZipFile(sys.argv[1]) as archive:
    assert 'META-INF/MANIFEST.MF' in archive.namelist()
    assert archive.testzip() is None
PY
  install -m 0644 "$TEMP_DIR/komga.jar" "$JAR"
fi
cat >/etc/systemd/system/komga.service <<UNIT
[Unit]
Description=Komga library server for MangaSee
After=network-online.target
Wants=network-online.target
[Service]
User=komga
Group=komga
WorkingDirectory=/var/lib/komga
Environment=KOMGA_CONFIGDIR=/var/lib/komga
Environment=SERVER_ADDRESS=127.0.0.1
ExecStartPre=/usr/local/sbin/mangasee-check-library $LIBRARY_PATH
ExecStart=/usr/bin/java -Xmx2g -jar /opt/komga/komga-1.22.0.jar
Restart=on-failure
RestartSec=10
UMask=0027
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ReadOnlyPaths=$LIBRARY_PATH
[Install]
WantedBy=multi-user.target
UNIT
cat >/etc/systemd/system/mangasee.service <<UNIT
[Unit]
Description=MangaSee reading room
After=network-online.target komga.service
Wants=network-online.target komga.service
[Service]
User=mangasee
Group=mangasee
WorkingDirectory=/opt/mangasee/current
EnvironmentFile=/etc/mangasee/app.env
Environment=NODE_ENV=production
ExecStartPre=/usr/local/sbin/mangasee-check-library $LIBRARY_PATH
ExecStart=/usr/local/bin/node dist-server/server/index.js
Restart=on-failure
RestartSec=5
UMask=0027
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ReadOnlyPaths=$LIBRARY_PATH
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now komga
READY=no
for (( attempt=0; attempt<120; attempt++ )); do
  if curl -fsS --max-time 3 http://127.0.0.1:25600/api/v1/claim >/dev/null 2>&1; then READY=yes; break; fi
  sleep 2
done
[[ "$READY" == yes ]] || { echo 'Komga did not become ready; inspect journalctl -u komga' >&2; exit 1; }
python3 "$SOURCE/ops/proxmox/bootstrap.py"
install -m 0755 "$SOURCE/ops/proxmox/extract.py" /usr/local/lib/mangasee-extract.py
install -m 0755 "$SOURCE/ops/proxmox/update.sh" /usr/local/sbin/mangasee-update
install -m 0755 "$SOURCE/ops/proxmox/backup.sh" /usr/local/sbin/mangasee-backup
/usr/local/sbin/mangasee-update "$ARCHIVE"
# Preserve Debian's previous Caddy config once; this is a dedicated fresh LXC.
[[ -f /etc/caddy/Caddyfile.before-mangasee ]] || cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.before-mangasee
cat >/etc/caddy/Caddyfile <<CADDY
$SITE_ADDRESS {
  tls internal
  encode zstd gzip
  reverse_proxy 127.0.0.1:3000
}
komga.$SITE_ADDRESS {
  tls internal
  reverse_proxy 127.0.0.1:25600
}
CADDY
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl enable mangasee caddy
systemctl restart caddy
CA=/var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt
for (( attempt=0; attempt<30; attempt++ )); do [[ -f "$CA" ]] && break; sleep 1; done
install -m 0644 "$CA" /etc/mangasee/root.crt
curl -fsS --retry 5 --retry-delay 2 --max-time 10 --cacert /etc/mangasee/root.crt \
  --resolve "$SITE_ADDRESS:443:127.0.0.1" "https://$SITE_ADDRESS/api/health" >/dev/null
{
  printf 'Node: '; /usr/local/bin/node --version
  printf 'Komga: 1.22.0\n'
  caddy version
  java -version 2>&1
  dpkg-query -W caddy default-jre-headless
} >/etc/mangasee/versions.txt
touch /etc/mangasee/install-complete
printf '\nInstalled. Credentials: /etc/mangasee/credentials.json (root only)\n'
printf 'Trust /etc/mangasee/root.crt on your devices, then open https://%s\n' "$SITE_ADDRESS"
