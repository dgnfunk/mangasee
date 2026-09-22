#!/usr/bin/env bash
set -euo pipefail
# Also executed as each service user; verifies actual unprivileged UID access.
LIBRARY_PATH="${1:-/library}"
if [[ ! -d "$LIBRARY_PATH" ]]; then
  echo "Library folder missing or inaccessible: $LIBRARY_PATH. Attach the folder, or use CREATE_LIBRARY_DIR=yes for a new local library." >&2
  exit 1
fi
if [[ ! -r "$LIBRARY_PATH" || ! -x "$LIBRARY_PATH" ]]; then
  echo "Library folder is not readable/traversable by $(id -un): $LIBRARY_PATH. Check its parent directories and permissions." >&2
  exit 1
fi
[[ "$(timeout -k 2 10 cat "$LIBRARY_PATH/.mangasee-library")" == mangasee-library ]] || {
  echo 'Library identity marker unavailable. Attach the real library folder before starting services.' >&2; exit 1;
}
