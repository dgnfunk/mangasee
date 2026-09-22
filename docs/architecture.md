# Architecture and interfaces

Browser → same-origin Fastify API → Komga read API. SQLite is authoritative for virtual organization and progress. Originals remain in user-managed folders visible to Komga. Storage is mounted/provisioned outside the application; it may be local or network-backed.

## Data ownership

- `books`: stable application UUID, unique Komga identity, imported metadata, display overrides, source revision and availability. No filename-based reassignment.
- `series` / `memberships`: one optional virtual series per book, explicit ordered membership, reader settings.
- `collections` / `collection_series`: many-to-many shelves of series.
- `progress`: page or EPUB CFI, completion, monotonically increasing version and timestamp.
- `mutations`: idempotency records for successfully applied progress writes.
- `sessions`: hashed opaque tokens, expiry; password changes invalidate sessions.
- `state`: last completed catalog refresh and configuration fingerprint.

Schema version 1 is created transactionally using SQLite `user_version`. Foreign keys are enforced. No online scraper or remote telemetry is included.

## Application API

All `/api/*` endpoints except health and login require the session cookie. Mutations require an Origin equal to `APP_ORIGIN`. JSON validation rejects out-of-range fields.

| Endpoint | Behavior |
| --- | --- |
| `GET /api/health` | Process liveness |
| `POST /api/session/login` | `{password}`; rate-limited login |
| `GET /api/session`, `POST /api/session/logout` | Session state / revoke |
| `GET /api/status`, `POST /api/sync` | Dependencies and catalog reconciliation |
| `GET /api/books` | `search`, `format`, `status`, `series`, `collection`, zero-based `page`, `size` (max 200) |
| `GET/PATCH /api/books/:id` | Book details / `{title?, volume?}` |
| `GET /api/books/:id/next` | Next available volume across the whole virtual series |
| `GET /api/books/:id/pages` | One-based page descriptors |
| `GET /api/books/:id/cover`, `/file`, `/page/:page` | Authenticated streamed content; optional revision must match |
| `POST /api/books/:id/relink` | `{replacementId}`; explicit unavailable→available identity replacement |
| `GET/POST /api/series`, `PATCH/DELETE /api/series/:id` | Series and preferences |
| `POST /api/series/:id/books` | `{bookIds}`; atomic assignment |
| `PUT /api/series/:id/order` | Exact full membership permutation |
| `DELETE /api/books/:id/series` | Remove membership, retaining book/history |
| `GET/POST /api/collections`, `PUT/DELETE /api/collections/:id` | `{title, seriesIds}` |
| `GET/PUT /api/books/:id/progress` | Versioned read progress |

Progress writes contain `{page, cfi, completed, baseVersion, mutationId}`. A stale version returns HTTP 409 with the remote progress; the UI offers local/server choice. Repeated successful mutation IDs return the original result. Choosing local submits a fresh mutation based on the displayed server version; another concurrent change produces another conflict.

Relinking preserves the original application ID, labels, series and progress and replaces the source linkage. The replacement must be available, unorganized and unread. It is removed as a separate catalog record. This deliberately refuses to guess how two independently organized histories should merge.

## Offline storage

IndexedDB contains download manifests, local progress, pending writes and cached library settings. Cache Storage holds only explicitly requested book downloads, keyed by stable ID and source revision. The service worker precaches the app shell, including the EPUB reader chunk, and serves explicit cached book content before network requests. The reader also loads cached pages as short-lived blob URLs and EPUBs directly from Cache Storage, without requiring a network-shaped fetch. Login and mutable APIs are never cached.

A download becomes complete only after all required content keys exist. Verification detects eviction. A revision change discards the previous download before replacement. Pausing retains completed pages. Downloads run in the foreground; a browser termination can interrupt them, and Resume reuses cached pages. Device logout clears downloads and pending progress after warning the user.

## Reader and security boundaries

CBZ/CBR/PDF decoding belongs to Komga; the app requests JPEG pages explicitly, including for PDFs. The client renders nearby pages only, with geometry placeholders for vertical scrolling. EPUBs use a separate sandboxed EPUB.js rendition. Scripts are disabled and the response CSP blocks remote fonts/images/connections and embeds. External EPUB links are removed. No code is executed from publication content.

Local HTTP is only for localhost development. Production uses trusted HTTPS and Secure cookies. Komga credentials never reach the browser; admin setup stays on an SSH-forwarded loopback port. Password login is personal-use scope, not a public multi-user service.
