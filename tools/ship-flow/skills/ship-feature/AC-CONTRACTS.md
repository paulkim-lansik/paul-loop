# AC contracts — syntax reference

The one-line acceptance-criterion format that makes `ship-feature` step 3's runtime-verify gate
machine-checkable instead of self-reported (ADR-0104). `SKILL.md` step 1 states the requirement;
this file is the format. Read it while writing the plan.

## Syntax

Quoted verbatim — this matches `ac-verify.sh`'s parser exactly. An optional leading markdown list
marker (`- `) is tolerated.

```
AC: <description> | verify: <command> | artifacts: <path1>,<path2> | expect: <substring>
```

- Only `AC: <description>` is required.
- `verify:`, `artifacts:`, and `expect:` are each **optional**, may appear in **any combination**,
  and in **any order**.
- Fields are separated by ` | ` (space-pipe-space).
- `artifacts:` paths are **comma-separated**, not space-separated — a path may itself contain
  spaces, so spaces cannot be the separator.

## Field semantics

| Field | What `ac-verify.sh` does with it |
|---|---|
| `verify:` | Runs the command as a subprocess; a zero exit code passes |
| `artifacts:` | Checks each listed path exists after the run |
| `expect:` | Checks the `verify:` command's output contains this substring |

Each is a deterministic subprocess judgment, which is the point: the gate's result doesn't depend on
the agent's own account of whether the feature works.

## Examples

A behavioural check with an expected substring in the output:

```
AC: login rejects a wrong password | verify: pnpm --filter api test -- auth.spec.ts | expect: 401
```

A check that a build actually produced something:

```
AC: the CLI builds a standalone binary | verify: pnpm build | artifacts: dist/cli,dist/cli.map
```

Description only — legitimate for criteria a human has to eyeball, as long as the plan carries at
least one contracted AC elsewhere:

```
AC: the empty-state illustration is not clipped on a 320px viewport
```

## The floor, and why it exists

For a `standard` or `risky` track — anything with a runtime surface; `docs-only` is exempt because
step 3 is already skipped for it — **the plan as a whole must express at least one AC with a
machine-checkable contract** (a `verify:` field, and/or `artifacts:`/`expect:`).

Not every AC needs one. But **zero across the whole plan** means step 3's `ac-verify.sh` gate has
nothing to evaluate, so it would pass vacuously — a green gate proving nothing. That is why the
`ship-flow:planner` agent fail-closed-checks this before any code exists, and why step 3 fails
closed rather than skipping when a `standard`/`risky` plan has no contracted AC.
