#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
node "$HERE/lessons-evidence-integrity.test.mjs"
