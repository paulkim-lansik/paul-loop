# The Lessons Memory (Phase 3)

Phases 0–2 make a single run converge and gate quality. Phase 3 is the **learning layer**: it makes
runs get *smarter over time*. It implements two ideas from the research, under the same discipline
as the rest of loop-engine.

- **Reflexion** — a failure becomes a *verbal lesson* stored in memory, recalled into the next
  attempt that hits the same failure. (Shinn et al. 2023, verbal self-reflection as memory.)
- **Voyager** — a *recurring, verified* lesson becomes a candidate to codify into a reusable skill
  or guideline. (Wang et al. 2023, an ever-growing skill library.)

> ⚠️ The lessons research (Reflexion / Voyager / SEAL) was NOT independently fact-checked in this
> project's web pass; treat these as the design's stated inspiration, not verified claims.

## The discipline: only the verifier decides what is a lesson

This is the same rule as Phase 1 (the verifier is the ceiling), applied to memory:

- A lesson is marked **`verified`** only when **ground truth** — the verifier passing after a fix —
  confirmed it. `loop-fix.sh` records a verified lesson *only on SUCCESS*, keyed to the original
  failure. The fixer's self-report is never trusted.
- **Only verified lessons are recalled** as authoritative (`--include-unverified` to override).
- **Only recurring** (`count >= N`) verified lessons are **promoted** to skill/guideline candidates.
  So a one-off, or a hallucinated "fix", cannot pollute the memory or your guidelines.

This is the concrete form of "generator ≠ evaluator": what becomes institutional knowledge is
decided by the evaluator (the verifier), not the generator (the fixer).

## Store

One JSON file per lesson under the lessons dir, keyed by a **normalized failure signature** (strip
line numbers, paths, and digits, lowercase, sort, hash) so the *same kind* of failure recurs to the
same lesson. File-per-lesson is git-diffable and merge-friendly.

```json
{ "id": "<sig>", "title": "...", "fix": "...", "source": "loop-fix", "category": "engineering",
  "verified": true, "count": 3, "iterations": [2,1,3],
  "gate_history": { "pnpm verify": { "count": 2, "first_seen": "...", "last_seen": "..." } },
  "clean_pass_count": 0,
  "challenge": null, "retired": null,
  "invalid_at": "", "invalid_reason": "", "superseded_by": "", "invalidated_by": "",
  "first_seen": "...", "last_seen": "..." }
```

`category` is `engineering` (process/tooling lesson, the default) or `domain` (product/domain
lesson). Missing/legacy values coerce to `engineering` on read — no migration needed (BAC-498).

`gate_history` (BAC-631) attributes recurrences to verify gates (`record --gate`), keyed by the
normalized gate command (same rule as the runs ledger's `payload.cmd`). Missing/malformed values
coerce to `{}` on read — same read-time-default precedent as `category`, no migration. PASS history
is NOT copied here; the `.loop/runs` ledger stays the SSOT.

`clean_pass_count` (issue #9) is an exit-code-derived counter: `mark-clean --gate <cmd>` bumps it on
every lesson attributed to that gate (via `gate_history`) that is neither invalidated nor retired —
"how many times this gate has passed CLEANLY since this lesson's fix was last needed." `record`'s
fail-recurrence path (an existing lesson matched again) resets it to 0 — a recurrence is evidence the
lesson is NOT yet stable. `loop-fix.sh` calls `mark-clean` on every PASS (before `record`, so a lesson
that just recurred THIS run is not miscounted as clean), whether or not this run ever failed. Missing/
corrupt coerces to `0` on read — same read-time-default precedent as `category`/`gate_history`.
`promote`'s listing annotates candidates crossing an informational `CLEAN_RETIRE_THRESHOLD` (5) as
retirement candidates — a signal only, never an auto-invalidate/retire.

`invalid_at`/`invalid_reason`/`superseded_by`/`invalidated_by` (issue #6) record an `invalidate` call
— the lesson itself was WRONG, distinct from `retired` (the lesson was right but is now
superseded/codified). `invalid_at` is authoritative only as a non-empty string (empty = not
invalidated, the read-time default). An invalidated lesson is excluded, fail-closed, from every
downstream surface: `recall` (checked ahead of the verified check, so even a `verified: true` lesson
that was later invalidated is never recalled) and `promote` (listing / `--codify`).

## Commands

```bash
lessons record  --signature-file <verdict.txt> [--fix "..."] [--source loop-fix|eval-gate|diagnose|review]
                [--category engineering|domain] [--iterations N] [--verified] [--gate "<verify cmd>"] [--lessons <dir>]
lessons recall  --signature-file <verdict.txt> [--include-unverified] [--category engineering|domain] [--lessons <dir>]
lessons promote [--min-count N] [--codify] [--runs <runs-dir>] [--lessons <dir>]   # recurring verified → codify candidates
lessons retire  --id <key> --ref "<where codified>" [--lessons <dir>]   # TERMINAL: retire a codified lesson from the pool
lessons invalidate --id <key> [--reason "..."] [--superseded-by <id2>] [--by "<who>"] [--lessons <dir>]
                # mark a lesson WRONG (distinct from retire — right but superseded). Fail-closed
                # excluded from recall and promote (listing/--codify) from then on.
lessons mark-clean --gate "<verify cmd>" [--lessons <dir>]
                # bump clean_pass_count on every non-invalidated, non-retired lesson attributed to
                # --gate — "this gate passed cleanly, without this lesson's fix being needed again."
lessons stats   [--category engineering|domain] [--lessons <dir>]   # observability: convergence + avg iterations + retired/open/by-category counts
```

`stats --category <x>` narrows every OTHER metric (total/verified/recurring/...) to that category,
but `by_category: engineering=N domain=M` in its output is always the full, unfiltered breakdown.

`record`/`recall` take the failure from a Verdict block's `FAIL:` lines (Phase 0 contract), so the
memory composes with everything else.

`recall` is **signature recall** — an exact match on the normalized failure signature, no
similarity, no ranking (see CONTEXT.md and ADR-0062). Both stay silent on stdout with exit 0 (`loop-fix`
pipes this through `2>/dev/null`), but write one stderr line each:

- **No lesson recorded** for this signature — names the normalized key and routes hand-written
  natural-language queries to **semantic recall**
  (`pnpm --filter @glucofit-partners/loop-memory recall --query "<text>" --json`) instead, since a miss
  here is often a query that was never a supported input for this exact-match store.
- **A lesson exists but `--category` filters it out** — names the key and the category mismatch (the
  signature DID match; this isn't the "wrong store" case above, so no semantic-recall routing hint).

## Wired into the loop

```bash
loop-fix.sh --verify "npm test" --fix '<agent>' --protect "**/*.test.*" --guard-mutation --lessons .loop/lessons
```

- On each failing iteration, `loop-fix` **recalls** verified lessons for that exact failure and
  injects them into the fix prompt ("a past verified run hit this same failure — here's what worked").
- On **SUCCESS**, it first calls **`mark-clean --gate "$VERIFY"`** (bumping `clean_pass_count` on every
  lesson tied to this gate — runs even on a fully clean pass with no failure at all this run), THEN
  **records** a verified lesson tagged `--gate "$VERIFY"` when a failure was captured this run (the
  original failure → converged in N iterations). This order matters: if the run's own failure just
  recurred, `record`'s merge resets that lesson's `clean_pass_count` back to 0 right after `mark-clean`
  bumped it, so a lesson that just needed its fix again is never miscounted as a clean pass.

So the 5th time the loop meets a familiar failure, it starts with the answer instead of rediscovering
it — and `lessons stats` shows whether the loop is getting faster (avg iterations-to-green).

## gstack domain lessons (BAC-503, ADR-0065)

`gstack-scan.sh --lessons <dir>` (a manual step of the `retrospect` skill, not an automatic hook)
scans gstack's `learnings.jsonl` for domain-lesson candidates and records them into this same store —
`category: domain`, `source: gstack`. Scope is `learnings.jsonl` only. `source: "user-stated"` entries
(a human directly confirmed the insight) become `verified: true`; everything else is `verified: false`
and must clear the normal recurring + `challenge` bar. Dedup is exact-match on `sha256(skill:key)`; a
re-scan never bumps count or overwrites an existing lesson file. No other command changes — a verified
domain lesson graduates to pgvector and gets recalled exactly like a verified engineering lesson.

## Feeding forward (Phase 4 hooks)

- `lessons promote` surfaces recurring blockers — hand them to `write-a-skill` (codify the fix) or
  fold them into `CLAUDE.md` (a guideline). That is the review/diagnostic-findings → guidelines loop.
  With `--runs <runs-dir>` (opt-in, BAC-631) it also folds the `.loop/runs` ledger deterministically and
  annotates candidates whose recorded `--gate` regressed PASS→FAIL — a separate `[REGRESSION: …]` line,
  distinct from `[N×]`; the ledger is forgeable, so this is candidate input, never an auto-promotion.
- A *separate skeptical evaluator* agent can be added to challenge a promotion candidate before it
  becomes a skill; the verified-only + recurrence rules are the deterministic floor it builds on.
- Once codified, `lessons retire --id <id> --ref "<where>"` marks it TERMINAL so it stops re-surfacing
  (`promote` listing / `--codify` / loop-doctor's "promotion candidates"). Three gates in all: verified+recurring
  floor gates ENTRY, a recorded `accept` gates codification, and `retire` gates removal from the pool —
  so the candidate backlog reflects real open work, not a monotonic pile of already-done lessons.
