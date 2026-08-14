# Example: wiring a `verify` command in a turbo monorepo

This is an example, not a file this plugin installs verbatim — adapt the task names to what your repo
actually has (typecheck/lint/test are common; add build, or drop test if you don't have any yet, etc).
If your repo isn't a turbo monorepo, the only thing that matters for the rest of this plugin is that
`{{VERIFY_COMMAND}}` in your `CLAUDE.md`/`ship-flow.config.json` resolves to *something* that exits
non-zero on failure — a single `npm test`, a Makefile target, whatever fits.

## `turbo.json`

```json
{
  "$schema": "https://turbo.build/schema.json",
  "globalDependencies": ["<your linter config>", "<your tsconfig base>", "<your lockfile>"],
  "tasks": {
    "typecheck": { "dependsOn": ["^typecheck"] },
    "lint": {},
    "test": { "dependsOn": ["^typecheck"] },
    "build": { "cache": false, "outputs": ["dist/**", "!dist/**/*.map"] }
  }
}
```

`dependsOn: ["^typecheck"]` means "typecheck this package's dependencies before typechecking/testing
this package" — it's what makes turbo's dependency-graph-aware caching and `--affected` actually safe
to use instead of a full run.

## Root `package.json`

```json
{
  "scripts": {
    "verify": "pnpm install --frozen-lockfile && turbo run typecheck lint test"
  }
}
```

- `--frozen-lockfile` (or your package manager's equivalent) is a cheap CI-relevant safety check —
  it fails if `package.json` and the lockfile have drifted, instead of silently installing whatever
  resolves.
- If this repo also has this plugin's loop harness wired in (a `.loop`-based lesson store, a
  risk-classification rule table, etc.), chain that harness's own self-check onto the end of `verify`
  the same way — the harness's own regression coverage should ride the same gate everything else does,
  not a separate one nobody remembers to run.

## `--affected` in CI (optional, cost optimization for large monorepos)

Once a monorepo gets large enough that a full `turbo run` on every PR is slow/expensive, `turbo run
... --affected` only runs tasks for packages that actually changed (plus their dependents). The
trade-off: base it on a safety fallback, not blind trust — a change to a root-level file (lockfile,
root `package.json`, `turbo.json` itself) can affect every package in ways `--affected`'s git-diff
heuristic won't always catch, so treat any root-file change as "fall back to a full run," not just
"trust `--affected`."
