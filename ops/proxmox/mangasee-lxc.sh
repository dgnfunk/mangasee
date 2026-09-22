#!/usr/bin/env bash
# Run from the unpacked source bundle as root on the Proxmox host.
set -Eeuo pipefail
umask 077
SOURCE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
DRY_RUN=no
PREPARE_ONLY=no
case "${1:-}" in
  --dry-run) DRY_RUN=yes ;;
  --prepare) PREPARE_ONLY=yes ;;
  -h|--help) cat <<'HELP'
Usage: [settings] bash ops/proxmox/mangasee-lxc.sh [--dry-run|--prepare]
--prepare creates a stopped LXC so you can attach your library folder first.
LIBRARY_PATH=/library is the absolute folder path inside the LXC.
CREATE_LIBRARY_DIR=yes initializes a missing local folder during first installation.
It defaults to no and must be specified again when resuming if still needed.
Optional: CTID, CT_HOSTNAME=mangasee, CORES=2, MEMORY=4096, SWAP=512,
DISK=20, BRIDGE=vmbr0, IP_CONFIG=dhcp (or IPv4/CIDR), GATEWAY,
ROOT_STORAGE, TEMPLATE_STORAGE, SITE_ADDRESS=mangasee.home.arpa.
Resume: CTID=123 RESUME_EXISTING=yes bash ops/proxmox/mangasee-lxc.sh
The dry run validates settings and prints the plan without contacting Proxmox.
HELP
  exit 0 ;;
  '') ;;
  *) echo 'Unknown option' >&2; exit 2 ;;
esac
die() { echo "[ERROR] $*" >&2; exit 1; }
info() { echo "[MangaSee] $*"; }
CTID="${CTID:-}"
RESUME_EXISTING="${RESUME_EXISTING:-no}"
[[ "$RESUME_EXISTING" == yes || "$RESUME_EXISTING" == no ]] || die 'Invalid RESUME_EXISTING'
STATE_ROOT=/var/lib/mangasee-installer
if [[ "$RESUME_EXISTING" == yes ]]; then
  [[ "$CTID" =~ ^[1-9][0-9]{2,8}$ ]] || die 'Resume requires CTID'
  [[ -f "$STATE_ROOT/$CTID.conf" ]] || die 'No saved MangaSee installation exists for this ID'
  # Root-owned, shell-quoted configuration written by this script, not library content.
  # shellcheck disable=SC1090
  source "$STATE_ROOT/$CTID.conf"
  [[ -n "${LIBRARY_PATH:-}" && -z "${NAS_HOST:-}" ]] || die 'Legacy NFS installer state: see the migration notes in docs/proxmox-lxc.md.'
fi
CT_HOSTNAME="${CT_HOSTNAME:-mangasee}"
CORES="${CORES:-2}" MEMORY="${MEMORY:-4096}" SWAP="${SWAP:-512}" DISK="${DISK:-20}"
BRIDGE="${BRIDGE:-vmbr0}" IP_CONFIG="${IP_CONFIG:-dhcp}" GATEWAY="${GATEWAY:-}"
SITE_ADDRESS="${SITE_ADDRESS:-mangasee.home.arpa}"
LIBRARY_PATH="${LIBRARY_PATH:-/library}"
CREATE_LIBRARY_DIR="${CREATE_LIBRARY_DIR:-no}"
[[ "$CREATE_LIBRARY_DIR" == yes || "$CREATE_LIBRARY_DIR" == no ]] || die 'CREATE_LIBRARY_DIR must be yes or no'
ROOT_STORAGE="${ROOT_STORAGE:-}" TEMPLATE_STORAGE="${TEMPLATE_STORAGE:-}"
[[ "$LIBRARY_PATH" =~ ^(/[a-zA-Z0-9_-][a-zA-Z0-9_.-]*)+$ ]] || die 'LIBRARY_PATH must be an absolute folder path without spaces, trailing slash, or dot components'
case "$LIBRARY_PATH" in /etc|/etc/*|/proc|/proc/*|/sys|/sys/*|/dev|/dev/*|/opt/mangasee|/opt/mangasee/*|/var/lib/mangasee|/var/lib/mangasee/*|/var/lib/komga|/var/lib/komga/*) die 'Choose a dedicated library folder, separate from system/application data';; esac
[[ "$CT_HOSTNAME" =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]] || die 'Invalid container hostname'
[[ "$SITE_ADDRESS" =~ ^[a-z0-9][a-z0-9.-]*[a-z0-9]$ && "$SITE_ADDRESS" == *.* ]] || die 'SITE_ADDRESS must be a DNS hostname, without scheme or port'
[[ "$BRIDGE" =~ ^[a-zA-Z][a-zA-Z0-9_-]*$ ]] || die 'Invalid bridge'
[[ "$IP_CONFIG" == dhcp || "$IP_CONFIG" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+/[0-9]+$ ]] || die 'IP_CONFIG must be dhcp or IPv4/CIDR'
[[ -z "$GATEWAY" || "$GATEWAY" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || die 'Invalid gateway'
[[ "$IP_CONFIG" != dhcp || -z "$GATEWAY" ]] || die 'Do not specify GATEWAY with DHCP'
for value in "$CORES" "$MEMORY" "$SWAP" "$DISK"; do [[ "$value" =~ ^(0|[1-9][0-9]{0,6})$ ]] || die 'Resources must be integers'; done
(( CORES >= 1 && MEMORY >= 2048 && DISK >= 12 )) || die 'Minimum: 1 core, 2048 MiB memory and 12 GiB disk; 4096 MiB recommended'
for value in "$ROOT_STORAGE" "$TEMPLATE_STORAGE"; do [[ -z "$value" || "$value" =~ ^[a-zA-Z0-9][a-zA-Z0-9_-]*$ ]] || die 'Invalid storage ID'; done
[[ -z "$CTID" || "$CTID" =~ ^[1-9][0-9]{2,8}$ ]] || die 'Invalid CTID (must be 100 or greater)'
python3 - "$IP_CONFIG" "$GATEWAY" <<'PYNET'
import ipaddress, sys
if sys.argv[1] != 'dhcp':
    ipaddress.IPv4Interface(sys.argv[1])
if sys.argv[2]:
    ipaddress.IPv4Address(sys.argv[2])
PYNET
if [[ "$DRY_RUN" == yes ]]; then
  cat <<PLAN
Create/resume: ${CTID:-next free CTID}; unprivileged Debian 13; ${CORES} CPUs; ${MEMORY} MiB; ${DISK} GiB local rootfs
Network: bridge=$BRIDGE ip=$IP_CONFIG gateway=${GATEWAY:-automatic}
Library folder inside LXC: $LIBRARY_PATH (mount/provision it yourself; read-only recommended)
Initialize missing local folder: $CREATE_LIBRARY_DIR (first installation only)
Folder identity checked before services start; no storage-provider configuration
Use --prepare to create the stopped container before attaching the folder
Native services: Node 24, Komga 1.22.0, Caddy; URL=https://$SITE_ADDRESS
Source: local bundle from $SOURCE_DIR; no GitHub publication required
Credentials generated inside LXC, never printed; settings saved for resume
PLAN
  exit 0
fi
[[ $EUID -eq 0 ]] || die 'Run on the Proxmox host as root'
for command in pct pvesh pvesm pveam pveversion python3 tar flock; do command -v "$command" >/dev/null || die "Missing $command"; done
[[ -n "$CTID" ]] || CTID="$(pvesh get /cluster/nextid)"
[[ "$CTID" =~ ^[1-9][0-9]{2,8}$ ]] || die 'Could not obtain a valid CTID'
exec 9>"/run/lock/mangasee-installer-$CTID.lock"
flock -n 9 || die "An installer for this CTID is already running"
CREATE_CT=yes
if CT_CONFIG="$(pct config "$CTID" 2>/dev/null)"; then
  CREATE_CT=no
  [[ "$RESUME_EXISTING" == yes ]] || die 'CTID already exists. Refusing to overwrite it.'
  # pct percent-encodes descriptions, including a trailing newline as %0A.
  # Capture the full output first: grep -q pipelines can also trip pipefail/SIGPIPE.
  CT_DESCRIPTION="$(python3 -c '
import sys
from urllib.parse import unquote
line = next((line for line in sys.stdin.read().splitlines() if line.startswith("description: ")), "description: ")
print(unquote(line[len("description: "):]).strip())
' <<< "$CT_CONFIG")"
  if [[ "$CT_DESCRIPTION" != 'MangaSee managed LXC v2' ]]; then
    printf '[ERROR] CT %s has an unexpected installer description: %q\n' "$CTID" "$CT_DESCRIPTION" >&2
    die "Expected MangaSee managed LXC v2. Inspect pct config $CTID; do not relabel an unrelated container."
  fi
  grep -Fxq 'unprivileged: 1' <<< "$CT_CONFIG" || die 'Expected an unprivileged container'
fi
HOST_ARCH="$(dpkg --print-architecture)"
case "$HOST_ARCH" in amd64|arm64) ;; *) die 'Unsupported host architecture';; esac
pick_storage() { pvesm status -content "$1" | awk 'NR>1 && $3=="active" {print $1; exit}'; }
ROOT_STORAGE="${ROOT_STORAGE:-$(pvesm status -content rootdir | awk 'NR>1 && $3=="active" && $1=="local-lvm" {print $1; exit}')}"
ROOT_STORAGE="${ROOT_STORAGE:-$(pvesm status -content rootdir | awk 'NR>1 && $3=="active" && $2 ~ /^(dir|lvmthin|lvm|zfspool|btrfs)$/ {print $1; exit}')}"
TEMPLATE_STORAGE="${TEMPLATE_STORAGE:-$(pick_storage vztmpl)}"
[[ -n "$ROOT_STORAGE" && -n "$TEMPLATE_STORAGE" ]] || die 'Need active rootdir and vztmpl storage'
TEMP_DIR="$(mktemp -d)"
trap 'rm -rf -- "$TEMP_DIR"' EXIT
trap 'code=$?; echo "[ERROR] Install stopped at line $LINENO. Container and data preserved. Resume with CTID=$CTID RESUME_EXISTING=yes using this source bundle." >&2; exit "$code"' ERR
if [[ "$RESUME_EXISTING" == no ]]; then
  [[ ! -e "$STATE_ROOT/$CTID.conf" ]] || die 'Managed paths already exist; inspect them before proceeding'
  install -d -m 0700 "$STATE_ROOT"
  for key in CTID CT_HOSTNAME CORES MEMORY SWAP DISK BRIDGE IP_CONFIG GATEWAY SITE_ADDRESS LIBRARY_PATH ROOT_STORAGE TEMPLATE_STORAGE; do printf '%s=%q\n' "$key" "${!key}"; done >"$STATE_ROOT/$CTID.conf"
fi
if [[ "$CREATE_CT" == yes ]]; then
  pveam update >/dev/null
  TEMPLATE="$(pveam available --section system | awk -v arch="$HOST_ARCH" '$2 ~ /^debian-13-standard_/ && $2 ~ ("_" arch "\\.tar\\.(zst|xz|gz)$") {print $2}' | sort -V | tail -n 1)"
  [[ -n "$TEMPLATE" ]] || die 'No matching Debian 13 template available'
  pveam download "$TEMPLATE_STORAGE" "$TEMPLATE"
  NET0="name=eth0,bridge=$BRIDGE,ip=$IP_CONFIG"
  [[ -z "$GATEWAY" ]] || NET0+=",gw=$GATEWAY"
  # Proxmox writes guest resolver/hostname files during setup. Do not let the
  # installer's private-file umask make those system files unreadable to _apt.
  (umask 022; pct create "$CTID" "$TEMPLATE_STORAGE:vztmpl/$TEMPLATE" --hostname "$CT_HOSTNAME" --arch "$HOST_ARCH" \
    --cores "$CORES" --memory "$MEMORY" --swap "$SWAP" --rootfs "$ROOT_STORAGE:$DISK" \
    --net0 "$NET0" --unprivileged 1 --features nesting=1 --onboot 1 --start 0 \
    --description 'MangaSee managed LXC v2')
else
  grep -Fxq "arch: $HOST_ARCH" <<< "$CT_CONFIG" || die 'Container architecture differs from host'
fi
if [[ "$PREPARE_ONLY" == yes ]]; then
  info "LXC $CTID prepared. Attach your folder at $LIBRARY_PATH inside the LXC."
  info "Create .mangasee-library in the real source folder containing mangasee-library."
  info "Resume: CTID=$CTID RESUME_EXISTING=yes bash ops/proxmox/mangasee-lxc.sh"
  exit 0
fi
if ! pct status "$CTID" | grep -q 'status: running'; then (umask 022; pct start "$CTID"); fi
for (( attempt=0; attempt<60; attempt++ )); do
  if pct exec "$CTID" -- getent hosts deb.debian.org >/dev/null 2>&1; then break; fi
  sleep 2
done
pct exec "$CTID" -- getent hosts deb.debian.org >/dev/null || die 'LXC DNS/network unavailable'
python3 "$SOURCE_DIR/scripts/package-lxc.py" "$TEMP_DIR/source.tar.gz" >/dev/null
pct push "$CTID" "$TEMP_DIR/source.tar.gz" /root/mangasee-source.tar.gz --perms 600
pct push "$CTID" "$SOURCE_DIR/ops/proxmox/install.sh" /root/mangasee-install.sh --perms 700
pct exec "$CTID" -- bash /root/mangasee-install.sh /root/mangasee-source.tar.gz "$SITE_ADDRESS" "$LIBRARY_PATH" "$CREATE_LIBRARY_DIR"
info "LXC $CTID is ready. IP addresses: $(pct exec "$CTID" -- hostname -I)"
info "Add local DNS for $SITE_ADDRESS and komga.$SITE_ADDRESS, then trust the exported Caddy CA on your devices."
info "Credentials: pct exec $CTID -- cat /etc/mangasee/credentials.json"
info "CA certificate: pct pull $CTID /etc/mangasee/root.crt ./mangasee-root.crt"
