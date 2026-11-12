#!/bin/sh
set -eu
base=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
installer="$base/dist/release/macos-arm64/bin/goal-progress"
if [ ! -x "$installer" ]; then
  echo 'Build this private Task Progress checkout first; see README.md and INSTALL-FOR-AI.md.' >&2
  exit 1
fi
exec "$installer" install --json "$@"
