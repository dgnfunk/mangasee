# Deploy MangaSee in a Proxmox LXC

MangaSee reads an ordinary folder visible inside its LXC. You manage the underlying storage and mount: local disk, a Proxmox mount point, or an existing network-backed folder all use the same application setup. The installer has no TrueNAS configuration, NFS client setup, host mount units, or snippet hooks.

Node, Komga and Caddy run as native systemd services in an unprivileged Debian 13 LXC. Komga indexes the folder and serves its books to MangaSee. Databases, credentials, thumbnails and HTTPS certificates stay on the LXC root disk; choose local host storage for that disk. Docker is not required; [Compose with an existing local folder](deployment.md) is an alternative.

## 1. Package on your Mac

From the project directory, with Python 3.12 or newer:

```sh
python3 scripts/package-lxc.py /tmp/mangasee.tar.gz
scp /tmp/mangasee.tar.gz root@PROXMOX_IP:/root/mangasee.tar.gz
```

The bundle contains source and deployment helpers, excluding local secrets, databases, dependencies and build output. It needs no public Git repository. Only deploy trusted source: builds execute as the unprivileged application user.

## 2. Create the LXC on Proxmox

SSH into the node as root. You need a working bridge, root-disk and template storage, and internet access for installation. Snippets storage is not needed.

```sh
mkdir /root/mangasee-deploy
tar -xzf /root/mangasee.tar.gz -C /root/mangasee-deploy
cd /root/mangasee-deploy

# Optional preview; does not contact Proxmox or change anything.
LIBRARY_PATH=/library bash ops/proxmox/mangasee-lxc.sh --dry-run

# Choose an unused ID and storage names present on your node.
CTID=123 \
ROOT_STORAGE=local-lvm \
TEMPLATE_STORAGE=local \
LIBRARY_PATH=/library \
SITE_ADDRESS=mangasee.home.arpa \
bash ops/proxmox/mangasee-lxc.sh --prepare
```

`--prepare` creates a stopped LXC and saves settings. It does not start the application or scan a folder. Defaults: 2 cores, 4096 MiB RAM, 512 MiB swap, 20 GiB root disk, bridge `vmbr0`, DHCP. Reserve its address in your router.

| Setting | Example | Purpose |
| --- | --- | --- |
| `LIBRARY_PATH` | `/library` or `/mnt/manga` | Folder **inside the LXC**; saved during preparation |
| `CREATE_LIBRARY_DIR` | `yes` | Initialize a missing local library during first installation; default `no`, specified per invocation |
| `CTID`, `CT_HOSTNAME` | `123`, `mangasee` | Unused ID and guest hostname; ID defaults to next free |
| `CORES`, `MEMORY`, `SWAP`, `DISK` | `2`, `4096`, `512`, `20` | CPU, MiB RAM/swap, GiB root disk |
| `BRIDGE` | `vmbr0` | Existing bridge |
| `IP_CONFIG`, `GATEWAY` | `192.168.1.60/24`, `192.168.1.1` | Static IPv4; omit gateway with DHCP |
| `ROOT_STORAGE`, `TEMPLATE_STORAGE` | `local-lvm`, `local` | Local root disk and template archive storage |
| `SITE_ADDRESS` | `mangasee.home.arpa` | Local DNS hostname without scheme/port |

Use an absolute guest library path without spaces, trailing slash or `..`, separate from system/application data. A storage of type `dir` is not necessarily backed by a local disk: select the intended local root storage explicitly. Allow extra disk space for thumbnails, retained releases and backups.

## 3. Attach your folder

For example, if your books are already accessible at `/mnt/books` on the Proxmox node, attach that folder to the stopped container:

```sh
# This source folder must already contain/be the actual mounted library.
test -d /mnt/books
pct set 123 --mp0 /mnt/books,mp=/library,ro=1
```

Use a source path without symlinks. Use an unused `mpN` if `mp0` already exists; do not overwrite another mount. If you chose `LIBRARY_PATH=/mnt/manga`, use `mp=/mnt/manga`. You can instead provision the folder through your existing LXC mount workflow or initialize a new local folder as described below. By default, the installer expects the folder to exist and never creates or remounts a source directory.

Before making the source read-only, create `.mangasee-library` **in the real library folder** containing `mangasee-library` and a newline. For the example above, after confirming `/mnt/books` is the real source:

```sh
printf 'mangasee-library\n' > /mnt/books/.mangasee-library
```

If the host source is already read-only, create the marker through the storage's normal management path. Do not put it in an empty fallback directory underneath a missing mount. This storage-independent check lets services refuse startup and MangaSee preserve its catalog when the configured folder is unavailable. The installer creates a marker only when explicitly initializing a new, previously absent local folder.

Grant directory read/traverse and file read permissions to the `komga` and `mangasee` service users. They are created on the first resume attempt; if access fails, inspect their IDs:

```sh
pct exec 123 -- id komga
pct exec 123 -- id mangasee
```

With the default Proxmox unprivileged UID map, host UID = 100000 + guest UID; check the actual map if customized. Apply appropriate read ACLs on your source folder, then resume again. Do not recursively change book ownership or make the container privileged as a workaround. Both services also receive a systemd read-only view of the configured library path.

You own mount availability and boot ordering. If the source is a separate filesystem, make sure it is mounted before the container starts. The generic marker check does not manage mounts or certify every book's permissions. An LXC may start while its reading services remain stopped because the library is unavailable.

### Create a new local folder during installation

For a fresh local library, set `CREATE_LIBRARY_DIR=yes` on the install/resume command. For example, CT 123 whose saved `LIBRARY_PATH` is `/mnt/library`:

```sh
CTID=123 RESUME_EXISTING=yes CREATE_LIBRARY_DIR=yes \
  bash /root/mangasee-deploy/ops/proxmox/mangasee-lxc.sh
```

If `/mnt/library` is absent, the installer creates it and any missing parents with mode `0755`, and writes `.mangasee-library` with mode `0644`. The folder is root-owned; add books through your root/file-management workflow and give the services read access to new files. Their systemd view remains read-only. Books placed in a folder on the root filesystem consume the CT's disk space. Attaching external storage remains a separate storage-management step.

This option is not saved for future resumes. Existing folders, files, markers and permissions are preserved; symlink paths are rejected. If a folder already exists but is unreadable, fix its access permissions. If it exists without a marker, follow the marker instructions above after confirming it is the intended library. Once application credentials, a database or the completed-install record exist, the installer refuses to initialize a missing replacement folder.

For an already unpacked older bundle, copy the three updated scripts from your Mac before using the option:

```sh
scp ./ops/proxmox/{mangasee-lxc.sh,install.sh,check-library.sh} root@PROXMOX_IP:/root/mangasee-deploy/ops/proxmox/
```

## 4. Install the services and register the local folder

From the unpacked bundle on the Proxmox node:

```sh
CTID=123 RESUME_EXISTING=yes bash ops/proxmox/mangasee-lxc.sh
```

The installer starts the container, checks the configured folder as both service users, and registers **that guest path** as the initial Komga library. Books then appear in MangaSee after Komga analysis and a library refresh. No NAS address or export credentials are needed.

It installs Node pinned by `.nvmrc` (24.21.0), Komga 1.22.0, and Java/Caddy from Debian packages; installed versions are recorded in `/etc/mangasee/versions.txt`. It generates a personal app password, a Komga administrator, and a restricted reader/API key for the library. Daily scanning is enabled; file conversion, extension repair and automatic trash emptying are disabled. App and Komga listen on loopback, with Caddy providing LAN HTTPS.

Saved settings in `/var/lib/mangasee-installer/123.conf` take precedence on resume. Reuse the same source bundle after a failed installation; credentials and existing library IDs are retained. Once registered, keep the guest library path stable. Additional roots are added in Komga administration, not by changing the installer's saved path. The script refuses unrelated existing containers and never destroys containers on failure.

### Resume reports “This is not a container created by this installer”

An earlier installer compared the description literally. Proxmox can return `description: MangaSee managed LXC v2%0A`, where `%0A` is an encoded trailing newline. This is a valid MangaSee marker, but the old comparison rejected it. The corrected script decodes the description before checking it and reads configuration once to avoid pipe failures. Missing, unrelated and older `v1` markers still fail validation.

For an existing CT such as 123, inspect it on the Proxmox host:

```sh
pct config 123 | grep -E '^(description|hostname|unprivileged|arch):'
```

If it has the `MangaSee managed LXC v2%0A` marker, replace only the host installer with the corrected copy. From your Mac, substituting your node address if `PROXMOX_IP` does not resolve:

```sh
scp ./ops/proxmox/mangasee-lxc.sh root@PROXMOX_IP:/root/mangasee-deploy/ops/proxmox/mangasee-lxc.sh
```

Then resume on the Proxmox host:

```sh
CTID=123 RESUME_EXISTING=yes bash /root/mangasee-deploy/ops/proxmox/mangasee-lxc.sh
```

This requires no recreation, description changes or mount changes. If the description actually belongs to another installer or version, investigate that difference instead of relabeling the CT to bypass validation.

### Resume reports `mangasee-update: command not found`

An earlier installer installed the helper at `/usr/local/sbin/mangasee-update` but invoked it by name. A minimal `pct exec` environment may omit `/usr/local/sbin`. The corrected installer invokes the helper by absolute path and explicitly configures the command search path. The updater also uses the pinned Node/npm paths and passes its PATH to the build user.

From your Mac, replace both scripts in the host bundle:

```sh
scp ./ops/proxmox/{install.sh,update.sh} root@PROXMOX_IP:/root/mangasee-deploy/ops/proxmox/
```

Then resume on the Proxmox node:

```sh
CTID=123 RESUME_EXISTING=yes bash /root/mangasee-deploy/ops/proxmox/mangasee-lxc.sh
```

The existing library folder and generated Komga credentials are reused. `CREATE_LIBRARY_DIR=yes` is no longer needed once the folder exists. Resume the full installer rather than only running the updater: Caddy configuration and the final HTTPS checks occur afterward.

## DNS, certificate trust and first use

Point both local DNS records to the LXC's address:

- `mangasee.home.arpa` — MangaSee
- `komga.mangasee.home.arpa` — Komga administration

Custom `SITE_ADDRESS` values use `komga.<SITE_ADDRESS>` for administration. Keep these services on the home network; do not forward router ports. Configure your Proxmox firewall, if enabled, to permit LAN HTTPS and required outbound DNS/package access. The installer does not change firewall or router settings.

On the Proxmox host:

```sh
pct exec 123 -- cat /etc/mangasee/credentials.json
pct pull 123 /etc/mangasee/root.crt /root/mangasee-root.crt
```

Use `app_password` for MangaSee; `admin_email` and `admin_password` for Komga. Do not share this JSON file. Copy only `mangasee-root.crt` to your devices using a trusted channel. Trust the root certificate in macOS Keychain Access. On iPad, install the certificate profile and enable full trust under **Settings → General → About → Certificate Trust Settings**. Then open MangaSee in Safari and use **Add to Home Screen / Open as Web App**. No Apple developer subscription is involved.

Inspect Komga's scan/analysis results, then use **Refresh library** in MangaSee. MangaSee's refresh reconciles the catalog; it does not initiate a filesystem scan. To add books, place them in your mounted folder and let Komga scan it. To add a different folder, make it visible inside the LXC, open **Komga → Settings → Libraries → Add library**, and enter its guest path. Grant the generated reader user access to that library. Then scan/analyze in Komga and refresh MangaSee. Folder roots are currently managed through Komga administration; MangaSee manages virtual series and collections.

The installer guards the configured initial root. For additional independently mounted roots, manage their availability checks and mount ordering yourself, and keep them read-only. Placing more subfolders under the existing root requires no additional library configuration.

## Updates and backups

For the current update procedure, including the one-time Node and Komga security upgrades for older installations, see [updating an existing installation](updating.md).

Package the updated source on your Mac and copy it to the Proxmox host as above, then:

```sh
pct push 123 /root/mangasee.tar.gz /root/mangasee-update.tar.gz --perms 600
pct exec 123 -- /usr/local/sbin/mangasee-update /root/mangasee-update.tar.gz
```

The updater builds a new release while the old one runs. It then stops MangaSee, snapshots its data, switches the release symlink and checks health. A build failure leaves the running version untouched. A startup/health failure restores the previous release **and its database**, retaining failed data for investigation. It requires the bundle's pinned Node version to match the installed runtime. This command updates application code only; it does not silently upgrade Node, Komga, OS packages or deployment helpers. Review those changes separately and take a full LXC backup first.

Releases remain under `/opt/mangasee/releases`; update snapshots under `/var/backups/mangasee`. Retention is manual. Check disk space before updates and keep the current release and at least one compatible recovery snapshot. The updater and backup command share a lock.

For a consistent application/configuration backup:

```sh
pct exec 123 -- /usr/local/sbin/mangasee-backup
```

The command briefly stops all three services, archives data/configuration, and restarts services that were running. It prints the backup directory. Copy its files off the guest using `pct pull`; keep the corresponding source archive too. The state archive contains passwords, sessions and **private CA keys** and must remain private. It excludes library books and device-local offline downloads.

### Restore and host recovery

For complete recovery, take a Proxmox **stopped LXC backup** with your usual `vzdump`/PBS workflow, as well as the state backup. Bind-mount contents are excluded from Proxmox container backups: back up book originals separately. Retain `/var/lib/mangasee-installer/123.conf`, the source bundle, and your own mount configuration off the node.

Restore the LXC with the same numeric service UIDs and application versions. Reattach/provision the library at the same guest path before starting the services. On another node, arrange its source storage and boot ordering first. There are no MangaSee host mount units or snippet hooks to restore in this deployment.

To restore an older state archive within that recovered LXC, first copy the trusted archive into `/root`, check its recorded SHA-256, and retain a fresh backup of the current state. Stop the services, move `/var/lib/mangasee`, `/var/lib/komga`, `/var/lib/caddy`, `/etc/mangasee` and `/etc/caddy` to a root-only recovery directory, then extract `state.tar.gz` at `/` as root preserving numeric ownership (`tar --numeric-owner -xzpf /root/state.tar.gz -C /`). Do not merge an older SQLite database with newer WAL/SHM files. Restore the matching `/opt/mangasee/current` release from the backup's `release-path` (or the matching full LXC backup), run `systemctl daemon-reload`, then start Komga, MangaSee and Caddy. Check source availability, virtual series and reading progress before resuming use. A data-only backup is not a replacement for installed runtime binaries and the matching application release.

## Diagnose and validate

### Package downloads fail with “Temporary failure resolving”

This means name resolution failed inside the LXC. APT cannot download packages until the container can reach a working DNS resolver. It can be a DNS setting, missing route/address, firewall restriction or intermittent network failure; the error alone does not distinguish these.

On the Proxmox node, inspect the guest network and compare its resolver with the host's:

```sh
pct exec 123 -- sh -c 'ip -brief address; ip route; cat /etc/resolv.conf; getent ahostsv4 deb.debian.org'
cat /etc/resolv.conf
```

If the guest has no usable address or default route, correct its bridge/VLAN/DHCP or static gateway first. If those are present, check that its configured DNS server is reachable from the guest network. A loopback resolver such as `127.0.0.53` only works if a DNS service is actually running inside the guest; the host's loopback resolver is not accessible through the guest's loopback address.

Set an appropriate reachable resolver in **CT → DNS → DNS server**, or run `pct set 123 --nameserver YOUR_LAN_DNS_IP` on the Proxmox host, replacing the placeholder with your actual resolver address. Prefer the LAN resolver that also serves your local MangaSee hostnames. Check `/etc/resolv.conf` in the CT afterward; if it has not updated, restart this container and check again. The installer leaves your DNS configuration under your control.

Verify both repository names resolve and a complete package-list refresh succeeds before resuming:

```sh
pct exec 123 -- getent ahosts deb.debian.org
pct exec 123 -- getent ahosts security.debian.org
pct exec 123 -- apt-get --error-on=any update
CTID=123 RESUME_EXISTING=yes bash /root/mangasee-deploy/ops/proxmox/mangasee-lxc.sh
```

The corrected guest installer checks both names and uses APT's strict update mode. It stops before dependency installation when DNS or repository refresh fails instead of proceeding with stale lists. To copy that fix from your Mac to an already unpacked deployment:

```sh
scp ./ops/proxmox/install.sh root@PROXMOX_IP:/root/mangasee-deploy/ops/proxmox/install.sh
```

Replace `PROXMOX_IP` with the node address if needed. This improves failure handling; fixing the actual guest network is still required. It does not require recreating the container or changing library mounts. APT documents strict update behavior in [the Debian manual](https://manpages.debian.org/trixie/apt/apt-get.8.en.html).

### Root resolves names, but APT still reports DNS failures

Test as APT's download user, `_apt`, rather than relying only on root's lookup:

```sh
pct exec 123 -- sh -c 'ls -ld / /etc; ls -l /etc/resolv.conf; namei -l /etc/resolv.conf'
pct exec 123 -- runuser -u _apt -- getent ahostsv4 deb.debian.org
pct exec 123 -- runuser -u _apt -- getent ahostsv4 security.debian.org
```

The earlier host installer passed its restrictive `umask 077` to Proxmox create/start commands. Proxmox's guest setup writes resolver files, so that inherited mask can leave them unreadable to unprivileged processes. The host installer now uses `umask 022` just for container creation/start, while preserving root-only permissions on saved installer state. The guest installer checks resolver readability and DNS as `_apt` before running APT. These checks do not disable APT's sandbox or change container privileges.

If inspection confirms `/etc/resolv.conf` is a regular root-owned file with mode `600` or `640`, restore its normal read permissions and retest:

```sh
pct exec 123 -- chmod 0644 /etc/resolv.conf
pct exec 123 -- runuser -u _apt -- getent ahostsv4 deb.debian.org
pct exec 123 -- runuser -u _apt -- getent ahostsv4 security.debian.org
pct exec 123 -- apt-get --error-on=any update
```

If it is a symlink, inspect the target and parent-directory permissions first. If permissions already allow reading but `_apt` still fails, investigate DNS intermittency, routing or guest/host security-policy denials; changing nameservers again may not address that difference. Do not use recursive `chmod`, change `_apt` to root, or make the LXC privileged.

Copy **both** updated installer scripts from your Mac, then resume on the node:

```sh
# Mac:
scp ./ops/proxmox/{mangasee-lxc.sh,install.sh} root@PROXMOX_IP:/root/mangasee-deploy/ops/proxmox/

# Proxmox node:
CTID=123 RESUME_EXISTING=yes bash /root/mangasee-deploy/ops/proxmox/mangasee-lxc.sh
```

Replacing only `mangasee-lxc.sh` leaves the old guest installer in use: each resume copies `ops/proxmox/install.sh` from the host bundle into the LXC.

### Service and library checks

```sh
pct exec 123 -- systemctl --no-pager status mangasee komga caddy
pct exec 123 -- journalctl -u mangasee -u komga -u caddy -n 100 --no-pager
pct exec 123 -- curl -fsS http://127.0.0.1:3000/api/health
pct config 123
```

The authenticated app status reports library-folder availability and Komga connectivity. If storage disappears, restore your mount first and check the marker as both service users. Restart Komga and MangaSee after access returns; inspect Komga's scan results before refreshing the catalog. Do not create an empty replacement folder/marker to bypass the guard.

### Migrating from the earlier NFS installer

If you only generated the earlier scripts and have not deployed them, use this guide directly. A deployed older LXC can keep its existing `/library` mount and continue using `mangasee-update`; legacy `NAS_SENTINEL` environment settings remain supported by the application. The updated host installer deliberately refuses the old saved NFS configuration rather than silently taking over its mounts.

To move an existing installation to user-managed storage, back up the LXC and data, stop its services/container, and arrange the replacement mount at the **same `/library` path with the same books and marker**. Preserve the Komga database so its book identities stay stable. Review and remove the old `hookscript` reference only after your replacement mount/boot-order checks are ready. Remove the old host mount unit and snippet only when no container uses them; do not unmount a live source. Keep the existing saved state for recovery. Application-only updates do not migrate the host storage configuration or replace installed deployment helpers.

Local verification: `python3 scripts/test-proxmox.py` or `npm run test:deploy`. Tests exercise source packaging, unsafe archive rejection, settings validation, missing/wrong folder guards, credential bootstrap idempotence, and update success/build-failure/health-failure rollback with mocked system commands. They do not certify a real Proxmox deployment.

Still required on your infrastructure: initial install, reboot/folder guard, representative CBZ/CBR/PDF/EPUB analysis, trusted iPad HTTPS/PWA launch, storage outage recovery and an actual backup restore. Record results in [milestones](milestones.md).

References: [Proxmox container bind mounts](https://pve.proxmox.com/pve-docs/chapter-pct.html), [Komga JAR installation](https://komga.org/docs/installation/jar/), and the [Komga 1.22.0 API schema used by bootstrap](https://github.com/gotson/komga/blob/1.22.0/komga/docs/openapi.json).
