#!/usr/bin/env bash
set -euo pipefail
# Restores ONLY to an empty directory; never overwrites a running installation.
archive="${1:?Supply a backup archive}"
target="${2:?Supply an empty restore directory}"
mkdir -p "$target"
if [ -n "$(ls -A "$target")" ]; then echo 'Restore destination must be empty' >&2; exit 1; fi
tar -xzf "$archive" -C "$target"
echo 'Restored. Set DATA_ROOT to this directory, restore your separate .env, then start the matching application version.'
