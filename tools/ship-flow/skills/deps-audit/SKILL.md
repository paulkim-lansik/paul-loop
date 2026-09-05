---
name: deps-audit
description: Maintenance check for installed Claude Code extensions (marketplace plugins, skills.sh skills, gstack, and repo-embedded skills). Produces one report answering whether upstream is still maintained, whether the local install is current, and what's unused. Use when the user asks to audit or clean up skills/plugins, find unused skills, check whether things are up to date, check for divergence, or when a weekly heartbeat nudges.
context: fork
---

Follow the [shared authorization and completion contract](../AUTHORIZATION.md) before this procedure.

# deps-audit — extension maintenance dashboard

> **Output language.** Read `outputLanguage` (a BCP-47 tag, e.g. `ko`) from
> `.claude/ship-flow.config.json` and write **every human-facing prose artifact** — reports, summaries,
> questions, PR and tracked-issue bodies, your final message — in that language. **Code, commands, flags,
> identifiers, file paths, branch names, and quoted tool output stay verbatim; never translate them.** Key
> absent or unreadable → fall back to the language the user is writing in; never error on this.

Answers whether each installed extension **(1) is maintained upstream, (2) is your install current, and (3) what's unused**. Sweeps all four install channels — marketplace plugins, skills.sh, gstack, and repo-embedded skills — in one pass.

## Run

Run this repo's installed loop-engine plugin's `deps-audit` script. The commands below are
**substitutable literals** beginning with `{{pluginBinPrefix}}` (BAC-753): read `pluginBinPrefix` from
`.claude/ship-flow.config.json`, replace the token with its value **concatenated onto the script name
with no separator**, and run the result verbatim — never type a `{{…}}` token into a shell. The default
(key absent) is `""`, since in a live session a plugin's `bin/` is already on PATH. If this repo's CI or
its own wrapper needs an explicit resolver, the value is something like
`node "$LOOP_ENGINE_PATH/bin/plugin-path.mjs" exec bin/` — loop-engine's own bundled resolver
(`exec <relative-bin> [args...]`, env-var overrides `LOOP_ENGINE_PATH`/`SHIP_FLOW_PATH`/`LOOP_MEMORY_PATH`),
which covers what bare-PATH doesn't: CI (no live plugin load) or resolving a *different* installed
plugin's path. `deps-audit.mjs` takes **no `--` separator** — its flags go directly after the script name:

```bash
{{pluginBinPrefix}}deps-audit.mjs                      # fast — local manifests + usage + gh freshness (no clone)
{{pluginBinPrefix}}deps-audit.mjs --deep                # + skills.sh merge-base divergence (your edits vs staleness)
{{pluginBinPrefix}}deps-audit.mjs --json                # machine-readable
{{pluginBinPrefix}}deps-audit.mjs --refresh-provenance  # regenerate the sidecar (run after `npx skills update`)
```

If `CLAUDE_PROJECT_DIR` isn't set, it treats CWD as the project. Check the installed command's actual
write behavior before invoking it: versions that stamp `.loop/deps-audit.last` (including `--json`)
would change the audited repository. Use a verified non-writing mode or a necessary isolated fixture
whose outputs cannot affect audited resources; otherwise inspect permitted manifests directly and
report unavailable coverage. An explicit no-write-anywhere request also rules out temporary fixtures,
clones and caches. Do not invent a
`--no-stamp` flag or broaden a source-only audit into reading global settings/session history.
`--deep` may create needed isolated disposable clones within the investigation unless those writes
are forbidden. `--refresh-provenance` writes a global sidecar and needs that separate scope.

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
2. **Update proposal**: `🟠` (zero local edits) is a compatibility candidate, not authorization to
   update every global skill. Review the exact targets; apply only explicitly authorized updates.
   For `🟡`, inspect the real patch and propose a 3-way merge using the recorded install base.
   → **Run `--refresh-provenance` right after updating** to reset the fast staleness verdict (skip it and the next fast run will false-flag as stale again). Deep self-corrects its base off `updatedAt`, so a stale sidecar doesn't break it.
3. **Cleanup**: confirmed removal candidates (disabled-and-unused plugins, skills unused for 90d+) go through user approval before `npx skills remove -g -y <name…>` / `claude plugin uninstall <plugin>`. Destructive, so never auto-delete — back up the lock file first. Refresh provenance after removing.
4. **gstack**: if behind, propose its documented upgrade; execute only within explicit update scope.
5. Return maintenance notes in the requested report. Writing external memory/notes needs explicit
   authorization; a useful insight does not authorize storing it elsewhere.

## Discipline

- **Reporter by default.** Complete the judgment inputs without installing/updating/removing plugins.
  A separately authorized maintenance action follows its exact target scope. Preserve the installed
  command's real side-effect limits above. Read-only forbids stamps/sidecar changes in audited or live
  resources; needed isolated disposable clones and test outputs are allowed unless expressly forbidden.
- **Provenance never touches the lock file** — it lives in a separate sidecar (`~/.agents/.skill-provenance.json`). A skills.sh reinstall overwriting the lock file doesn't affect it.
- Fail-open: if `gh`, the network, or a file is missing, it reports what it can without crashing.
