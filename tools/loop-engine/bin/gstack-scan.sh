#!/usr/bin/env bash
# Thin wrapper so the gstack scanner composes like the other bin/ tools.
exec node "$(cd "$(dirname "$0")" && pwd)/gstack-scan.mjs" "$@"
