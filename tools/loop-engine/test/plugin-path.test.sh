#!/usr/bin/env bash
# Runtime migration: retain missing/malformed registry, scope/override isolation, CLI
# dispatch, argv, exit-code and space-path coverage; add manifest/version validation.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
node --test "$HERE/plugin-path.test.mjs"
