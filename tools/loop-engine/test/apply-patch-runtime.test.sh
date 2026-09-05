#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
node --test "$HERE/apply-patch-runtime.test.mjs"
