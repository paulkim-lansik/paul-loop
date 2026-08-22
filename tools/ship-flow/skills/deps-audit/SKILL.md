---
name: deps-audit
description: Maintenance check for installed Claude Code extensions (marketplace plugins, skills.sh skills, gstack, and repo-embedded skills). Produces one report answering whether upstream is still maintained, whether the local install is current, and what's unused. Use when the user asks to audit or clean up skills/plugins, find unused skills, check whether things are up to date, check for divergence, or when a weekly heartbeat nudges.
context: fork
---

# deps-audit — extension maintenance dashboard

Answers whether each installed extension **(1) is maintained upstream, (2) is your install current, and (3) what's unused**. Sweeps all four install channels — marketplace plugins, skills.sh, gstack, and repo-embedded skills — in one pass.

## Run

Run this repo's installed loop-engine plugin's `deps-audit` script — invoked however this repo
resolves plugin bin scripts (BAC-753). In a live session this is usually just the bare script name —
a plugin's `bin/` is already on PATH once it's loaded. The example below uses loop-engine's own
bundled resolver, `bin/plugin-path.mjs` (`exec <relative-bin> [args...]`, env-var overrides
`LOOP_ENGINE_PATH`/`SHIP_FLOW_PATH`/`LOOP_MEMORY_PATH`), for contexts bare-PATH doesn't cover — CI (no
live plugin load) or resolving a *different* installed plugin's path; a repo that installs loop-engine
a different way may invoke it differently:

```bash
<however this repo invokes its installed loop-engine plugin's bin scripts> deps-audit.mjs                      # fast — local manifests + usage + gh freshness (no clone)
<however this repo invokes its installed loop-engine plugin's bin scripts> deps-audit.mjs --deep                # + skills.sh merge-base divergence (your edits vs staleness)
<however this repo invokes its installed loop-engine plugin's bin scripts> deps-audit.mjs --json                # machine-readable
<however this repo invokes its installed loop-engine plugin's bin scripts> deps-audit.mjs --refresh-provenance  # regenerate the sidecar (run after `npx skills update`)
```

If `CLAUDE_PROJECT_DIR` isn't set, it treats CWD as the project (run from the repo root). Each run (including `--json`) stamps `.loop/deps-audit.last` with a timestamp so a weekly heartbeat, if this repo has one, can throttle re-runs.

## What it reads (source of truth)

| Channel | Manifest |
|---|---|
| Marketplace plugins | `~/.claude/plugins/{installed_plugins,known_marketplaces}.json` + `~/.claude/settings.json` (enabledPlugins) |
| skills.sh | `~/.agents/.skill-lock.json` + `~/.agents/.skill-provenance.json` (merge-base sidecar) |
| gstack | `~/.claude/skills/gstack` (git repo) |
| Repo-embedded | `<repo>/.claude/skills/*` — provenance = **this project's own git history** |
| Usage | `~/.claude.json` { `skillUsage`, `pluginUsage` } |

## Reading the report (what each verdict is based on, and its limits)

- **Freshness (`up Nd`)**: days since upstream's last commit. `>365d` surfaces as "possibly unmaintained" in the recommendations. If `gh` isn't authenticated, this column is **blank** (header banner shows `gh:off (freshness unknown)`, fail-open). If the repo is deleted, private, or rate-limited, it shows `lookup✗` + "lookup failed" in the recommendations (it never guesses from a blank freshness column).
- **Stale/current (fast)**: compares the skills.sh install's base sha against upstream HEAD sha. **sha-based, so it can overcount** (upstream moved but the specific skill file didn't change). **`--deep` is authoritative for content-level verdicts**. If both are unknown, shows `?`.
- **Divergence (`--deep`)**: reconstructs the install-time commit as the merge base, then diffs `local vs base` = **your edits, isolated**.
  - `🟡` (edits kept) — real local edits exist → updating needs a 3-way merge.
  - `🟠` (safe to update) — zero local edits, upstream moved on → **safe to bulk-update**.
  - `🟢` — already current and unedited.
  - `⚠️` (can't verdict) — local folder missing, base commit not found, upstream reorganized its paths, or a non-GitHub URL got rejected. These stay "undetermined" rather than being downgraded to clean/stale, and are excluded from bulk-update candidates.
  - **Trap**: if upstream reorganizes a skill's path, the merge base can resolve to a stub and produce a **false positive** `🟡`. Always eyeball the actual patch before trusting a `🟡` verdict.
- **Unused (`🗑️`)**: `usageCount==0` and last used `>90d` ago. **Caveat**: `skillUsage` is keyed by name, so a global copy and a project copy of the same name have their usage counts summed together. A plugin with `pluginUsage==0` may still be in use **through a skill or MCP tool it provides** — marked `ⓘ` (cross-check before removing). Only disabled-and-unused is a confirmed removal candidate. **If `~/.claude.json` fails to parse, the unused/removal analysis is skipped entirely** (shown as `use?`) rather than risk a false positive leading to a false deletion.
- **Repo-embedded `★`** = authored here (first commit isn't a vendor stamp), unmarked = vendored (first commit is `vendor …` — i.e. cloned and left as-is). The signal is the first commit's *message*, not commit count. Shows `?` if the git lookup fails. Provenance is this project's own git history.

## Maintenance workflow (recommended)

1. **Weekly**: when a heartbeat nudges, run `/deps-audit` (fast) as a sweep.
2. **Update**: `🟠` (zero local edits) is safe to bulk-update via `npx skills update -g`. For `🟡`, eyeball the real patch first, then do a 3-way merge (`~/.agents/.skill-provenance.json`'s `installBaseCommit` is the merge base).
   → **Run `--refresh-provenance` right after updating** to reset the fast staleness verdict (skip it and the next fast run will false-flag as stale again). Deep self-corrects its base off `updatedAt`, so a stale sidecar doesn't break it.
3. **Cleanup**: confirmed removal candidates (disabled-and-unused plugins, skills unused for 90d+) go through user approval before `npx skills remove -g -y <name…>` / `claude plugin uninstall <plugin>`. Destructive, so never auto-delete — back up the lock file first. Refresh provenance after removing.
4. **gstack**: if it's behind, run `/gstack-upgrade` (if this repo's owner uses gstack).
5. If this repo's owner tracks skill/plugin maintenance notes in some external memory or notes tool, divergence strategy and past corrections are worth logging there — specific skill names rot too fast to be worth hardcoding into this file.

## Discipline

- **Read-only reporter.** This skill never deletes or updates anything — it only produces the judgment inputs. Removal and updates require human approval.
- **Provenance never touches the lock file** — it lives in a separate sidecar (`~/.agents/.skill-provenance.json`). A skills.sh reinstall overwriting the lock file doesn't affect it.
- Fail-open: if `gh`, the network, or a file is missing, it reports what it can without crashing.
