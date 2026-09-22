# Pre-publication security review

Reviewed 2026-09-21. Scope: the initial public source snapshot, original generated fixtures, npm lockfile, application authentication/content handling, source packaging and deployment configuration. This is a focused source review and regression check, not a penetration test or certification of a live installation.

## Findings addressed before publication

- **High — API authentication/origin bypass:** protection relied on the raw URL prefix, while the router accepts decoded static path segments. Protection now follows the resolved API route. Regression tests cover encoded catalog, series, collections, status, book content and write requests, including session revocation.
- **Privacy — browser content retention:** ordinary book responses previously allowed long-lived HTTP caching. They now use `Cache-Control: no-store`; intentional offline downloads remain in the explicit device cache.
- **Privacy — repository and source bundles:** removed personal workstation paths and host identifiers from the documentation. Expanded Git/Docker and source-bundle exclusions for credential files, certificates/private keys, database sidecars, archives and logs. Reviewed the staged file inventory; local databases, output, traces and dependencies are not published. Both EPUB fixtures contain generated test text, not library books.
- **Privacy — backup creation:** the Compose backup script now uses `umask 077` before creating an archive containing credentials and private CA material.
- **Upstream — Komga:** changed the deployment pin from 1.21.2 to 1.22.0, the first release fixing [GHSA-m7mm-6jxp-2m4x / CVE-2025-52880](https://github.com/gotson/komga/security/advisories/GHSA-m7mm-6jxp-2m4x). The advisory affects 1.8.0–1.21.3 and describes crafted EPUB content executing actions as the user, potentially leading to code execution when an administrator reads it. Added SHA-256 verification for the installer JAR. Checked the endpoints against the 1.22.0 schema; actual Komga deployment/migration remains an operator check. This is a minimal security upgrade, not the latest Komga version.
- **Upstream — runtime pins:** updated Node from 24.13.0 to [24.21.0](https://nodejs.org/en/blog/release/v24.21.0), following intervening security releases, and the Compose Caddy pin from 2.10.2 to 2.11.4. LXC Caddy is supplied by the configured Debian package source and needs separate patch maintenance.
- **Reliability — tablet storage failures:** successful network responses remain visible if metadata persistence fails, with a separate device-storage warning and a retry/resume path.

## Checks completed locally

- Gitleaks 8.30.1 over the staged-source export, including archive traversal for the generated EPUB fixtures: no detected secrets.
- `npm audit`: zero reported npm advisories across production and development dependencies at review time. This does not scan Node itself, OS packages, Caddy, Komga or container base images.
- `npm run check`: 14 tests, type checks and production build passed.
- `npm run test:deploy`: 13 tests passed, including source exclusions, unsafe archive rejection and updater rollback simulation.
- `npm run test:e2e`: 17 Chromium/WebKit checks passed; the existing WebKit cold offline launch check is skipped because of the documented test-environment limitation.
- Local execution used Node 26.8.2. The GitHub workflow is configured to check the pinned Node 24.21.0 runtime on Linux.

## Remaining deployment and security boundaries

Existing servers do not receive fixes merely because this repository is public. Follow [updating an existing installation](updating.md), including the separate Node/Komga steps for older LXC installations. The running server, its logs, actual certificates and tablet storage were not inspected in this review. The tablet failure's precise cause is still unconfirmed.

The application is for a trusted LAN/VPN and a single personal library. Keep the Komga administrator interface private, maintain host security updates, and do not expose the app through router port forwarding. Only add trusted publications. The review did not exhaustively fuzz EPUB parsing, assess denial-of-service resistance, scan container images, or verify the live network/firewall.

Offline files are intentionally retained on a trusted device and are not remotely erasable by revoking its server session. Previously cached HTTP responses on old clients are not retroactively removed by the new response headers. Do not clear browser data until any pending progress is synchronized.

GitHub checks use read-only permissions, pinned action commits and no deployment credentials. Dependabot configuration covers npm, Dockerfile and GitHub Actions updates; Compose image pins and native LXC runtime versions also need manual review. Secret scanning and push protection complement, but cannot replace, review of future changes.
