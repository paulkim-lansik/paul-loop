#!/usr/bin/env bash
set -euo pipefail
node --test "$(dirname "$0")/runtime-packages.test.mjs"
