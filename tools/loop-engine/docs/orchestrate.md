# The human-in-the-loop gate & skeptical codify rule (Phase 4)

Phase 4 answered two questions the earlier phases deliberately deferred:

1. **Which actions get a human approval checkpoint, and which run autonomously?** (the research
   left this open — there was no concrete decision rule.)
2. **What stops a one-off or a plausible-but-wrong "lesson" from being codified into a permanent
   guideline?** (Phase 3 gave the deterministic floor — *verified + recurring* — but no judgement.)

Both decisions are deterministic and live in dedicated, tested cores: `bin/gate.mjs` (the gate rule)
and `bin/lessons.mjs` `challenge` / `promote --codify` (the codify rule). **The sequencer that used to
drive stages through them — `bin/orchestrate.sh` and the `/orchestrate` skill — was retired (BAC-537,
ADR-0061).** Its two premises (a bash sequencer needed a home separate from an agent session, and
nightly runs needed a local cron driver) both collapsed: `/ship-feature` runs the whole
plan→implement→verify→review→improve flow autonomously in-session, calling `bin/classify-risk.sh`
(built on `gate.mjs`) before each stage instead of a `--<stage>-risk` flag, and ADR-0060 moved
unattended nightly runs to a **cloud routine** that wakes an agent rather than a headless script. See
[`ship-feature/SKILL.md`](../../ship-flow/skills/ship-feature/SKILL.md) (this plugin's `ship-flow`
package) for the current driver.

## 1. The gate decision rule (`bin/gate.mjs`)

An autonomous flow needs a defensible, explainable rule for *when to stop and ask a human*. We score
an action on three dimensions an agent has no innate sense of, and **any single sufficient condition
forces a checkpoint** (a transparent lexicographic rule, not an arbitrary weighted score):

| Dimension | Meaning | Forces a gate when… |
|---|---|---|
| **reversibility** | can the action be cheaply undone? | `none` — deploy / delete / data migration / payment / outbound send / publish |
| **blast_radius** | how much does it affect? | `high` — ~>10 files, or prod / all-users scope |
| **cost** | money / external effects / cleanup time if it goes wrong | `high` — large API/compute spend, or expensive cleanup |

```
GATE = REQUIRE       if  reversibility == none  (or a dimension is missing/unrecognised)
     = DENY_AND_LOG  if  reversible but blast_radius == high  OR  cost == high
     = AUTO          otherwise
```

(3-tier since BAC-584 / ADR-0085 — the binary rule emitted REQUIRE on 36/40 real merged PRs, so the
verdict carried no routing information. Only the irreversible now *waits* for a human; the
reversible-but-broad tier is denied by default with its verdict evidence loaded into the PR body,
where the human actually reviews — that boundary is machine-enforced by BAC-616/563.)

**Fail closed** (the same discipline as the rest of loop-engine): a dimension that is *missing or
unrecognised* is treated as worst-case → REQUIRE. You cannot accidentally run a stage hot because a
risk field was blank. Two `medium`s stay AUTO — the rule is "any one *high/none*", deliberately not a
score, so it is always explainable ("it gated because reversibility=none").

The dimensions are **categorical on purpose**: the caller maps its concrete metric (file count,
dollar spend, "is this a prod deploy?") to a level, and `gate.mjs` is pure policy. Output is a
machine-readable block (`=== GATE === … === END GATE ===`); exit `0` = AUTO, `10` = REQUIRE, `11` =
DENY_AND_LOG (distinct from error/usage codes so a caller can branch on "needs approval" vs "broke").

```bash
gate.sh --action "prod deploy" --blast-radius high --reversibility none --cost high   # → REQUIRE, exit 10
gate.sh --action "rename a local var" --blast-radius low --reversibility full --cost low  # → AUTO, exit 0
```

`bin/classify-risk.sh`/`classify-risk.mjs` is the current caller: it derives blast/reversibility/cost
from the change itself (touched paths, stage, command via `--from-git`) instead of an agent
self-scoring, then feeds that into `gate.mjs`, taking `final = max(rule, agent-supplied)` — agent
input can only raise the classification, never lower it.

## 2. The skeptical evaluator: gating codification (`lessons challenge` + `promote --codify`)

Codifying a lesson into a skill or `CLAUDE.md` is itself a **high-blast-radius act** — it steers
*every* future run. So a verified, recurring lesson is necessary but **not sufficient** to codify it.
A **separate skeptical evaluator** (generator ≠ evaluator: a different agent from the one that
proposed/recorded the lesson) tries to **refute** the promotion, and its verdict is *recorded* so
codification is auditable:

```bash
lessons promote --min-count 3 --lessons .loop/lessons          # list candidates + their challenge status (with ids)
lessons challenge --id <id> --verdict reject --reason "one-off; too specific" --lessons .loop/lessons
lessons challenge --id <id> --verdict accept --reason "recurring class, general fix" --lessons .loop/lessons
lessons promote --codify --lessons .loop/lessons               # emits ONLY accepted candidates → write-a-skill / CLAUDE.md
```

The gate is deterministic and **fails closed**: `promote --codify` emits a candidate only if it is
**verified** *and* has a recorded `accept`. Unchallenged or rejected candidates never appear; a
hand-edited / merge-corrupted `challenge` field coerces to *unchallenged*; `--include-unverified`
relaxes only recall/listing and **never** the codify floor (an unverified, self-reported "fix" can
never be codified even if a skeptic accepted it); and if a later `record` changes the title/fix the
skeptic reviewed, the stale `accept` is **cleared** so the new content must be re-challenged. The
verified+recurring floor gates **entry** to the candidate pool; the recorded accept gates **exit** to
a codified guideline.
`/ship-feature` step 6 runs the skeptic adversarially (prompted to refute, **default-reject when
unsure**) — the same majority-refute discipline used to verify findings elsewhere.

## 3. Scheduling nightly runs

Unattended runs are now a **cloud routine** (ADR-0060, `/schedule`), which wakes an agent session
rather than driving a headless script — the gate and codify rules above still apply exactly as
documented, since `/ship-feature` calls `classify-risk.sh`/`gate.mjs` and `lessons.mjs` the same way
whether the session was started by a human or a schedule. **Set the gate honestly**: anything that
deploys, deletes, migrates, sends, or publishes is `rev=none` → it will pause for a human rather than
fire unattended.

## Invariants

- **The verifier is the ceiling** — a stage's exit code decides PASS/FAIL; no step asks a model
  whether a stage "succeeded".
- **Generator ≠ evaluator** — the skeptic that judges a promotion is a *separate* agent from the one
  that proposed it; the gate is a deterministic policy, not a model call.
- **Fail closed** — missing risk dims → REQUIRE; unchallenged/corrupt promotions → not codified.
- **Deterministic core, testable without an LLM** — `bin/gate.mjs` (the gate rule) and `bin/lessons.mjs`
  (`challenge` / `promote --codify`) are pure exit-code logic you can drive from a shell with stub
  inputs; no LLM is needed to verify the gate / codify behavior.
