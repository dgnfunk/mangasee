# VM / Compose deployment with a local folder

For an automated native LXC installation, see [the LXC installer guide](proxmox-lxc.md). This page describes the VM/Compose alternative.

## 1. Prepare the VM and library folder

Use a Linux VM with Docker Engine, Docker Compose v2, and your library folder already mounted or stored on the VM. Start with 2 vCPUs, 4 GB RAM, and local SSD space for databases/thumbnails. Adjust after measuring the real library. Clone/copy this project to `/srv/mangasee`.

Make your books available at a local path on the Docker host, for example `/mnt/books`. You manage the source storage and mount ordering. Grant UID/GID 1000 file read and directory traversal/read permissions. Create `.mangasee-library` in the actual library root containing `mangasee-library` followed by a newline. Do not create it in a fallback directory under an absent mount.

Compose binds this folder read-only at `/library` in each service. `create_host_path: false` rejects missing source directories, and the one-shot `library-check` validates the marker before app/Komga startup. MangaSee checks the marker before reconciling its catalog. This works with local disks and any storage you have already mounted; the application does not configure a storage provider. Arrange the underlying mount before starting Compose.

## 2. Configure local storage and secrets

```sh
sudo install -d -o 1000 -g 1000 /srv/mangasee/data/app /srv/mangasee/data/komga
sudo install -d /srv/mangasee/data/caddy /srv/mangasee/data/caddy-config
cp .env.example .env
chmod 600 .env
```

Edit `.env`:

- `APP_PASSWORD`: your own password, at least 12 characters.
- `APP_ORIGIN=https://mangasee.home.arpa` (no trailing slash).
- `SITE_ADDRESS=mangasee.home.arpa`.
- `DEMO_MODE=false`.
- `LIBRARY_SOURCE`: existing folder on the Docker host, for example `/mnt/books`.
- `DATA_ROOT=/srv/mangasee/data` on the VM's **local** filesystem.
- `KOMGA_API_KEY`: initially use a nonempty placeholder, then replace during bootstrap.

The container sets its own internal Komga URL and database path. The development-only `HOST`, `DATABASE_PATH`, and `PORT` entries are not passed into it.

## 3. Bootstrap Komga

```sh
docker compose up -d komga
```

Komga is bound to the VM's loopback interface. From your Mac:

```sh
ssh -L 25600:127.0.0.1:25600 your-user@your-vm
```

Visit `http://localhost:25600`, create the initial Komga administrator, and add a library rooted at `/library` or a subfolder. Keep these container paths stable across upgrades/restores. Disable automatic trash emptying. Initially use manual scans so you can inspect results on representative files before scheduling scans.

Create a dedicated MangaSee Komga user with access to the library and the **page streaming** and **file download** permissions. Generate an API key under that user's account and put it in `.env`. MangaSee needs read access, not Komga administrator access. Its application server never sends file deletion or metadata editing requests to Komga.

Scan/analyze the library in Komga. Correct unsupported/corrupt file errors there. CBR support depends on the archives that your pinned Komga release can decode. Test your actual RAR variants before importing everything.

## 4. Start MangaSee and trust HTTPS

```sh
docker compose up -d --build
docker compose ps
```

Create a local DNS record `mangasee.home.arpa` pointing to the VM. Do not forward router ports to this service. Caddy serves HTTPS using its private CA.

Copy `/srv/mangasee/data/caddy/caddy/pki/authorities/local/root.crt` to your Mac/iPad through a trusted channel. On Mac, import into Keychain Access and trust the certificate. On iPad, install the certificate profile, then enable full trust for it in **Settings → General → About → Certificate Trust Settings**. Labels can vary by iPadOS version. Keep the CA's private keys private; never distribute the entire Caddy data directory.

Open `https://mangasee.home.arpa` without a certificate warning. Sign in, refresh the library, and open a book. In Safari's Share menu choose **Add to Home Screen** / **Open as Web App**. Open the new icon and test a downloaded volume in airplane mode.

## 5. Ongoing operation

MangaSee reconciles Komga's catalog every 15 minutes and on startup; Refresh library performs the same reconciliation. This **does not initiate a Komga filesystem scan**. Add files through your existing file-management workflow, scan in Komga, then refresh MangaSee. Configure Komga's library scan schedule after validating storage stability.

Health endpoint `/api/health` checks the app process; authenticated `/api/status` reports library-folder availability, Komga connectivity, last successful catalog refresh and errors. A failed/incomplete source fetch cannot mark existing books missing. A successful scan which really lacks a file marks it unavailable while retaining its metadata/history.

```sh
docker compose logs --tail=100 app komga caddy
docker compose ps
```

For a storage outage: restore connectivity first; verify `library-check` can read the marker; inspect Komga before rescanning; refresh MangaSee. Never recreate an empty replacement directory or change the library root to make an outage disappear.

## Backup, restore and upgrades

Run from the project folder. Keep backups outside `DATA_ROOT`:

```sh
sudo DATA_ROOT=/srv/mangasee/data ./scripts/backup.sh /srv/backups/mangasee
```

The script stops writers and archives application data, Komga configuration, and Caddy certificates, then restarts services. Protect the archive: it contains sessions and private CA material. Back up `.env` separately and retain the matching source revision, package lockfile, and images. Back up the original book folder separately using your storage backup policy.

Restore to an **empty** directory:

```sh
sudo ./scripts/restore.sh /srv/backups/mangasee/mangasee-TIMESTAMP.tar.gz /srv/mangasee/restored-data
```

Stop the active stack, set `DATA_ROOT` to the restored directory, restore the matching `.env` and application/container versions, verify UID/GID permissions, then start the stack. Verify series membership, progress, and source availability. Browser downloads are device-local and are not in the server backup.

Before upgrades, take a backup. Container tags and the npm lockfile are pinned. Review changes and run `npm run check` plus browser tests before changing pins. The app refuses databases with newer schema versions. Rollback means restoring the compatible backup and matching application version, not running old code against an upgraded database.

When changing `LIBRARY_SOURCE`, stop the stack and verify the new source contains the same library and identity marker before recreating the containers. Keep the container path `/library` and Komga database stable to preserve book identity. Persisted databases remain under `DATA_ROOT`; back them up before deployment changes.

For an existing deployment using the earlier NFS volume configuration, first arrange the equivalent user-managed host folder, set `LIBRARY_SOURCE`, then recreate the stopped stack using this Compose file. Leave the old named volume alone until the new setup is verified; `down -v` is unnecessary.

Reference: [Docker Compose bind-mount configuration](https://docs.docker.com/reference/compose-file/services/#volumes).
