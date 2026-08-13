#!/usr/bin/env bash
# Thin wrapper so the lessons memory composes like the other bin/ tools.
exec node "$(cd "$(dirname "$0")" && pwd)/lessons.mjs" "$@"
