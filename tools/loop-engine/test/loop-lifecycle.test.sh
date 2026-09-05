#!/usr/bin/env bash
# Real subprocess/worktree fixtures; no model calls, no shared consumer state.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
node --test "$HERE/loop-lifecycle.cases.mjs"
