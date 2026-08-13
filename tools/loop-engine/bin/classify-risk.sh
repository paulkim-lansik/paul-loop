#!/usr/bin/env bash
# Thin wrapper so the deterministic risk classifier composes like the other bin/ tools.
exec node "$(cd "$(dirname "$0")" && pwd)/classify-risk.mjs" "$@"
