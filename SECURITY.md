# Security and privacy

MangaSee is a personal, single-library application intended for a trusted home network. A public source repository does not require exposing the running server to the Internet. Keep MangaSee and Komga behind the LAN/firewall or a trusted VPN; do not publish router ports.

Report vulnerabilities using this repository's **Security → Report a vulnerability** feature. Do not include passwords, API keys, cookies, books, private certificates, database exports or diagnostic traces in public issues.

Only application source, documentation and original generated test fixtures belong in Git. Keep `.env` variants, `credentials.json`, databases, library files, downloads, logs, browser traces, backups and Caddy certificate material private. Ignore rules are a safeguard, not a substitute for reviewing staged files. Production credentials are generated on the server; documented demo/test passwords are only for isolated fixtures.

Browser offline downloads and queued progress intentionally persist on the device. Use a trusted device and its screen lock. Server-side session revocation cannot erase copies already downloaded to an offline device. The app's sign-out flow removes explicit local downloads and local progress; sync first to avoid losing pending changes.

Keep Node, Komga, Caddy, the OS and npm dependencies patched. The LXC application updater does not upgrade those services. See [updating an existing installation](docs/updating.md) and the [pre-publication review](docs/security-review.md). A passing audit or secret scan does not establish that the application is free of vulnerabilities.
