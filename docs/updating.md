# Updating an existing installation

Use the updater for your installation type. Do not recreate the container or rerun the first-install wizard to apply app changes. Back up first. The September 2026 source includes the tablet storage/reconnect fix and API authentication hardening.

## Proxmox LXC

On your Mac, from the repository folder:

```sh
python3 scripts/package-lxc.py /tmp/mangasee-update.tar.gz
scp /tmp/mangasee-update.tar.gz root@PROXMOX_IP:/root/mangasee-update.tar.gz
```

On the Proxmox host, replace `123` with your existing container ID:

```sh
pct exec 123 -- /usr/local/sbin/mangasee-backup
pct push 123 /root/mangasee-update.tar.gz /root/mangasee-update.tar.gz --perms 600
pct exec 123 -- /usr/local/bin/node --version
```

The new source requires **Node 24.21.0**. If the last command shows another version, take a full LXC backup/snapshot and follow the runtime steps below before running the app updater. The updater deliberately refuses a runtime mismatch.

```sh
pct exec 123 -- /usr/local/sbin/mangasee-update /root/mangasee-update.tar.gz
pct exec 123 -- curl -fsS http://127.0.0.1:3000/api/health
pct exec 123 -- systemctl --no-pager status mangasee komga caddy
```

The updater stages/builds a new release, snapshots the app database and rolls back the app/database if its health check fails. It does **not** roll back separate runtime changes. Preserve the full LXC backup for those.

### One-time runtime updates for older LXC installs

Run `pct enter 123` on the Proxmox host. The following commands run **inside the existing LXC as root**, after a full backup. They download and verify artifacts before changing services. They retain the old Node directory and Komga JAR. Do not use these steps for a different installation layout.

Install the Node version required by `.nvmrc`:

```sh
set -eu
runtime_tmp=$(mktemp -d)
case "$(dpkg --print-architecture)" in
  amd64) runtime_arch=x64 ;;
  arm64) runtime_arch=arm64 ;;
  *) echo 'Unsupported architecture'; exit 1 ;;
esac
runtime_file="node-v24.21.0-linux-$runtime_arch.tar.xz"
curl -fSL "https://nodejs.org/dist/v24.21.0/$runtime_file" -o "$runtime_tmp/$runtime_file"
curl -fSL https://nodejs.org/dist/v24.21.0/SHASUMS256.txt -o "$runtime_tmp/SHASUMS256.txt"
(cd "$runtime_tmp" && awk -v file="$runtime_file" '$2==file {print;found=1} END{if(!found)exit 1}' SHASUMS256.txt | sha256sum --check -)
tar -xJf "$runtime_tmp/$runtime_file" -C /usr/local/lib/nodejs
chmod -R a+rX "/usr/local/lib/nodejs/node-v24.21.0-linux-$runtime_arch"
for bin in node npm npx; do
  ln -sfn "/usr/local/lib/nodejs/node-v24.21.0-linux-$runtime_arch/bin/$bin" "/usr/local/bin/$bin"
done
/usr/local/bin/node --version
```

Upgrade the original Komga **1.21.2** installation to **1.22.0**, the first fix for [GHSA-m7mm-6jxp-2m4x](https://github.com/gotson/komga/security/advisories/GHSA-m7mm-6jxp-2m4x). This is a minimal security upgrade, not a claim that it is the latest Komga release. If Komga is already newer, do not downgrade it. Review later releases separately.

```sh
grep '^ExecStart=' /etc/systemd/system/komga.service
# Proceed only if this shows the original /opt/komga/komga-1.21.2.jar.
curl -fSL https://github.com/gotson/komga/releases/download/1.22.0/komga-1.22.0.jar -o "$runtime_tmp/komga.jar"
printf '%s  %s\n' '6ee73bf422000de663432704ca64e6b24443dbe698ea741e71fd10a950c4815f' "$runtime_tmp/komga.jar" | sha256sum --check -
grep -q '/opt/komga/komga-1.21.2.jar' /etc/systemd/system/komga.service
install -m 0644 "$runtime_tmp/komga.jar" /opt/komga/komga-1.22.0.jar
cp -p /etc/systemd/system/komga.service /etc/systemd/system/komga.service.before-security-update
systemctl stop komga
sed -i 's@/opt/komga/komga-1\.21\.2\.jar@/opt/komga/komga-1.22.0.jar@' /etc/systemd/system/komga.service
systemctl daemon-reload
systemctl start komga
systemctl --no-pager status komga
```

Review available Debian/Caddy security updates with `apt-get update` and `apt-cache policy caddy`; install appropriate updates through the configured package source. The Compose Caddy pin does not control the LXC's package version. After runtime maintenance, exit the LXC shell and run the app updater above. If Komga migrations or runtime updates fail, restore the full LXC backup rather than downgrading a migrated database in place.

## Docker Compose

From the existing deployment folder, preserve the private `.env` and data directory. Back up with the existing script, then update the source from a reviewed commit (or copy the reviewed source files into that folder):

```sh
DATA_ROOT=/srv/mangasee/data bash scripts/backup.sh /srv/backups
# If this deployment is already a clone of the repository:
git pull --ff-only
# Pull the updated runtime services and rebuild the application.
docker compose pull komga caddy library-check
docker compose build --pull app
docker compose up -d
docker compose ps
```

Use your actual `DATA_ROOT` and backup destination. Runtime upgrades can migrate Komga data; retain the full matching backup for rollback.

## Refresh the tablet

After the server update, close **all** MangaSee browser tabs and the installed PWA, reopen, then reload once. The current service worker waits for old clients to close before activating an update. Confirm books load, open a book, and verify reading progress. Do not clear website data or uninstall the PWA to force an update: that can delete downloads and unsynced progress.
