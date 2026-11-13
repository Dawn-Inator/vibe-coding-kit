#!/bin/sh
set -eu
base=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "$base/scripts/install-from-kit.mjs" "$@"
