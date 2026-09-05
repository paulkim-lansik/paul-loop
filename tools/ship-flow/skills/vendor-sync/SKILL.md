---
name: vendor-sync
description: Compare this repo's vendored skills against upstream and report drift; apply bounded backports only when authorized. Use when checking for upstream drift, when a vendor-sync heartbeat nudges, or when the user asks whether vendored skills are current.
---

Follow the [shared authorization and completion contract](../AUTHORIZATION.md) before this procedure.

# vendor-sync — upstream drift for vendored skills

> **Output language.** Read `outputLanguage` (a BCP-47 tag, e.g. `ko`) from
> `.claude/ship-flow.config.json` and write **every human-facing prose artifact** — reports, summaries,
> questions, PR and tracked-issue bodies, your final message — in that language. **Code, commands, flags,
> identifiers, file paths, branch names, and quoted tool output stay verbatim; never translate them.** Key
> absent or unreadable → fall back to the language the user is writing in; never error on this.

Some of this repo's skills were taken from an upstream project and edited. They keep drifting from it,
in both directions, and nothing notices on its own. This is the round that notices.

**Half of this skill's value is deciding what *not* to apply, and writing down why.** A round that
applies everything upstream changed is not a sync, it is a revert of local work.

## The lock is the input — `skills-lock.json` at the repo root

Each entry names one vendored skill:

| field | meaning |
|---|---|
| `source` · `sourceType` | where it came from (e.g. `mattpocock/skills`, `github`) |
| `skillPath` | its path **in the upstream repo** — follows upstream renames, so a renamed skill stays tracked |
| `localPath` | where the local copy lives. Absent → `.claude/skills/<name>/SKILL.md` |
| `computedHash` | the local copy's content as last reconciled with upstream |
| `fork` *(optional)* | `{ reason, since }` — a **deliberate, permanent** divergence |

**A `fork` entry is never a bulk-apply candidate.** Report it, never re-propose it. Without this, every
round re-discovers the same divergence and re-argues it, and that noise is how a round stops being run.
Add `fork` when receiving upstream's version would be a *regression*, not merely a change.

`computedHash` is enforced by `vendor-lock-consistency.test.sh`, so a mismatch is already RED before
this round starts: **it means the local copy was edited since the last reconciliation.** That is the
"has local modifications — do not bulk-apply upstream over it" signal, and it is a fact rather than an
inference. (The older heuristic — counting commits touching the file — is a fallback for repos whose
lock predates the hash being enforced.)

## Scope first

A request to check currency or an ordinary reminder is inspect/report scope. It does not authorize
editing audited skills, stamping their state, committing or publishing a PR. Necessary isolated
disposable comparison fixtures or temporary reports are allowed unless those writes are forbidden.
A saved automation prompt may explicitly
authorize a bounded apply/stamp mode; use its actual scope. In apply mode, preserve deliberate forks
and complete the authorized backports without re-asking for the same work. Merge stays separately gated.

## Step 0 — the cheap check, always first

```bash
{{pluginBinPrefix}}mattpocock-skills-sync-check.mjs
```

(Substitute `{{pluginBinPrefix}}` per this repo's `.claude/ship-flow.config.json`, exactly as
`ship-feature` does. No `--` separator.)

One of four:

- `UNKNOWN` — unavailable authentication/network evidence. Report the gap; a bounded read-only
  diagnostic or transient retry is allowed. Do not report unchanged or stamp an unknown result.
- `UNCHANGED <sha>` — no upstream commits since the last check. **Go straight to Step 3** and report in
  one line. The deep comparison is skipped, and skipping it is the point.
- `FIRST_RUN <sha>` — no state file in this repo. Go to Step 1.
- `CHANGED <old> <new> <count>` — `<count>` new commits. Go to Step 1.

This check only knows `mattpocock/skills`. For a lock entry with a different `source`, compare it
directly in Step 1 rather than skipping it.

## Step 1 — deep comparison (only on FIRST_RUN / CHANGED)

### 1a. What this repo currently vendors

Read every lock entry. For each, note `localPath`, whether it carries `fork`, and — if this repo
records skill usage — how often it is actually used. **A heavily used skill is never proposed for
renaming**: updating every reference costs more than the rename gains.

### 1b. The upstream tree

```bash
gh api repos/<source>/contents/skills --jq '.[].name'
gh api repos/<source>/contents/skills/<category> --jq '.[].name'
```

Read each category's `README.md` too — it carries the one-line description and the
user-invoked/model-invoked split, so new and renamed skills can be triaged without opening every
`SKILL.md`.

### 1c. Classify

1. **Same name, content evolved** — split again by whether the hash says the local copy was edited.
2. **Renamed or restructured upstream** — `skillPath` no longer resolves. Locate the new path; moving
   to `deprecated/` means the author retired it, which is information, not a backport.
3. **New upstream skill, absent here** — this is an *adoption* question, not a comparison. Judge it
   against the skills this repo already has and its actual stack and conventions (read its `CLAUDE.md`
   / `CONTEXT.md`). Recommend adopt / hold / unnecessary. **Do not install it in this round.**

**A skill whose classification is unclear stays explicitly unresolved in the report, excluded from
automatic application.** Upstream path reorganisation produces convincing false positives; do not downgrade an unclear
case to either "clean" or "stale".

### 1d. Compare in parallel

Where delegation is available and authorized, dispatch one sub-agent per skill for classes 2 and 3,
and for any class-1 skill that is heavily used or locally edited. Otherwise compare directly. Give each agent: the absolute local path, an instruction to find the real local edits
since vendoring, and the upstream fetch:

```bash
gh api repos/<source>/contents/<upstream-path> --jq '.content' | base64 -d
```

Each returns, **read-only with no edits to audited files** (needed isolated disposable comparison
fixtures are allowed unless forbidden): (a) local customisations that must survive, (b) upstream
improvements worth taking, (c) differences that don't matter, (d) a recommendation — replace / apply
in part / ignore.

### 1e. Propose, or apply within authorized scope

- Pure additions that don't collide with local customisation (a new checklist item, a new subsection).
- No renames. No new file dependencies — if upstream's change requires a file this repo doesn't have,
  hold the whole skill and say so.
- **Structural refactors are a judgment call, not an automatic no.** Upstream turning a self-contained
  skill into a delegating stub is only safe if this repo *ships the delegation target and that target
  behaves the way this repo wants*. Taking the stub without owning the target is how a skill becomes a
  handoff to nothing — or worse, a handoff to behaviour the repo explicitly rejected.
- Anything touching a `fork` entry: report, never apply.

In report mode return the concrete proposed changes without editing. In apply mode, follow the
caller's assigned worktree and repository procedure. Update each changed `computedHash` in
`skills-lock.json` before verification and publication; coordinate the final bytes with a concurrent
lock owner. If commits are authorized, prefer one per skill. Open a PR only within publication scope;
otherwise return the verified local patch. A human approves any merge of the reviewed PR/head/base.

The PR body must carry all four:

- what was applied, and why (1–2 lines per skill)
- **what was not applied**, and why — local customisation preserved, missing dependency, `fork`
- **new upstream skills**, with an adopt/hold recommendation, left uninstalled
- rename candidates needing a human decision

If this repo keeps a skills index or catalogue doc, remind the user to update it when entries were
added or removed. If it doesn't, skip this silently.

## Step 2 — report

Return the report or actual PR link plus counts (proposed/applied, held, unresolved, new candidates).
Distinguish a finished inspection from incomplete evidence or failed requested publication.

## Step 3 — optional authorized bookkeeping, last

```bash
{{pluginBinPrefix}}mattpocock-skills-sync-check.mjs --stamp <the sha checked this round>
```

Stamp only if the request/saved automation authorizes local check-state updates and the check
completed successfully, including `UNCHANGED`. Explicit read-only requests never stamp. If a partial
comparison or an earlier failure prevented completion, report it without advancing the check timer.

Hash reconciliation belongs in the same authorized patch as the skill edits, before verification;
stamping is separate bookkeeping and does not prove the changes passed checks or were published.
