# Milestone acceptance record

Implementation is present for M1–M6. Release gates that require your infrastructure or physical iPad are **not claimed complete**. Versions v0.1–v1.0 below are acceptance milestones, not already certified releases.

## Local verification

- `npm run check`: **13 passing** unit/integration tests; TypeScript and production/PWA builds pass.
- `npm run test:e2e`: **13 passing, 1 explicitly skipped** across Chromium and WebKit.
- `npm run format:check`: passes. Backup/restore shell syntax checks pass. Compose YAML is parsed by the formatter, but Docker/container runtime checks have not run because Docker is unavailable in this workspace.
- `npm audit`: **0 reported vulnerabilities** for the committed lockfile. EPUB.js uses a pinned patched XML parser override.
- Visual inspection: desktop and iPad-sized library screenshots in `output/playwright/` (generated, ignored by version control).
- `npm run test:deploy`: **13 passing** local deployment tests, including prepare/resume with user-managed mounts, custom library paths, first-install local-folder initialization, early DNS/APT failure checks, minimal-PATH command lookup and mocked update/database rollback. No live Proxmox LXC deployment has run.
- Original fixtures: generated image pages plus reflowable/fixed-layout EPUB files. No actual storage books were supplied or tested.

## Milestone gates

| Milestone | Implemented and locally checked | Remaining acceptance |
| --- | --- | --- |
| M1 — Foundation | App scaffold, login, Komga adapter contract tests, Compose/local-folder/Caddy configuration, health/status, atomic catalog sync and missing-storage guard | Build/run containers on VM; validate mount permissions and CA trust; test real CBZ, CBR and PDF files; install on actual iPad |
| M2 — Organization | Search/filter/pagination; cross-folder virtual series; ordering; collections; display overrides; unavailable records and explicit relinking; preservation through reconciliation | Review grouping with your mixed-folder library; check real Komga ID behavior after file moves |
| M3 — Online reader / v0.1 | RTL/LTR; single/double/vertical modes; cover/wide-spread handling; offset/zoom; next volume beyond pagination; progress, idempotency and conflict API tests; browser read/resume and mode tests | 30-minute iPad session; actual pinch/swipe/pan feel; rotation checks; measure cached turns against 100 ms target; full iPad↔Mac conflict walkthrough |
| M4 — Offline / v0.2 | Foreground downloads; retry/removal/cache verification; quota failure test; local progress queue; Chromium offline reading and cold startup; WebKit cached reading during simulated HTTP outage | Actual iPad airplane-mode launch after app termination; large-volume pause/resume; storage-pressure behavior and device conflict resolution |
| M5 — EPUB / v0.3 | EPUB.js integration; reflow/fixed-layout fixture rendering in both browsers; TOC, text size, themes, direction and CFI writes; script/remote-image isolation; whole-file caching path | Your real EPUBs, font/rotation location checks and offline EPUB device testing; unsupported/DRM examples |
| M6 — Reliability / v1.0 | Schema migration version, database snapshot/restore test, 1,000-book catalog check, local backups/runbook, status/logging, outage-safe reconciliation, lockfile/container pins | Full container backup/restore on clean VM; real storage outage/VM restart; actual library performance; accessibility review with assistive technology; week of daily use |

## WebKit offline testing limitation

Playwright's WebKit 26.6 in this environment returns `WebKit encountered an internal error` for offline navigations **and even local `blob:` image URLs** after `context.setOffline(true)`. The cold-launch test is explicitly marked `fixme`; it is not counted as a pass. The WebKit cached-reading test instead blocks HTTP requests and emits an offline state while allowing local blobs. Chromium uses real offline emulation, including a full app reload.

This does not establish whether Safari on your iPad passes cold startup. That remains a mandatory M4 acceptance gate. Do not call offline iPad support verified until the physical-device check succeeds.

## Device and infrastructure worksheet

- iPad: **iPad Pro, 11-inch**; generation: pending; iPadOS: pending.
- Desktop: Mac; OS/Safari versions: pending.
- Truestorage export/IP and VM address: pending.
- Library book count, disk size and largest sample volume: pending.
- Certificate trusted without browser warnings: pending.
- Actual format samples: CBZ, CBR/RAR variants, PDF, reflowable EPUB, fixed-layout EPUB: pending.
- Thirty-minute session: pending.
- Cold offline iPad launch and saved position: pending.
- Clean restore rehearsal: pending.
- Seven-day usage acceptance: pending.

## Next deployment increment

Follow [the automated LXC guide](proxmox-lxc.md) for native Proxmox deployment, or [the VM/Compose guide](deployment.md). The LXC installer prepares a container, then provisions services, the chosen local-folder library/API credentials and HTTPS after you attach the folder; local DNS and device certificate trust remain manual steps. Start with a small representative library before scheduling whole-library scans. Keep release gates above open until results are recorded.

## September 2026 pre-publication update

The current source passed 14 application tests, 13 deployment checks, the production build and 17 browser checks (one existing WebKit offline cold-launch skip). See [security review](security-review.md) for fixed findings and limits, and [updating](updating.md) for applying the changes to an existing installation. Earlier counts above describe the original milestone run.
