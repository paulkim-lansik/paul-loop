#!/usr/bin/env bash
# Thin wrapper so the gate decision rule composes like the other bin/ tools.
exec node "$(cd "$(dirname "$0")" && pwd)/gate.mjs" "$@"
