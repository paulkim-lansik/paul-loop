#!/usr/bin/env bash
# Thin wrapper so eval-gate composes like the other bin/ tools (and as a loop-fix --verify target).
exec node "$(cd "$(dirname "$0")" && pwd)/eval-gate.mjs" "$@"
