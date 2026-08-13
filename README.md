# paul-loop

A Claude Code plugin marketplace for a self-improving dev loop harness. The core idea: **the
verifier is the ceiling** — tests, types, lint, whatever ground-truth check applies — and the
agent's own self-report never substitutes for it. Everything else (verified-fix memory, risk
gating, closed verify-fix loops) is built on top of that one invariant.

> Status: **M0 (private scaffold)**. This repo is being sanitized and validated before any public
> announcement. See [Milestones](#milestones) below.

## Plugins

This marketplace ships focused plugins instead of one monolith, so you only pay the token cost of
what you actually enable (`claude plugin details <name>` shows the projected cost per plugin).

- **`loop-engine`** (this milestone) — the core mechanics:
  - `verdict-run` — wraps any verify command and emits a machine-readable `PASS`/`FAIL` contract
    (see [`docs/verdict-contract.md`](tools/loop-engine/docs/verdict-contract.md))
  - `loop-fix` — a closed verify → fix → re-verify loop with a hard budget
  - `lessons` — records a fix only when a verifier confirmed it worked, recalls it next time a
    similar failure signature shows up, and promotes recurring ones toward codification
    (see [`docs/lessons.md`](tools/loop-engine/docs/lessons.md))
  - `classify-risk` / `require-tests` / `gate` — deterministic risk classification and anti-fake-green
    guards, not left to the agent's own judgement

More plugins (a delivery-loop skill stack, opt-in semantic lesson recall, issue-tracker bridges)
land in later milestones — see below.

## Install

```bash
claude plugin marketplace add paulkim-lansik/paul-loop
claude plugin install loop-engine@paul-loop
```

During development (pre-`M1`), pin to this repo directly instead of a released version, and expect
breaking changes without notice.

## Milestones

- **M0 (this milestone)** — private scaffold: secrets/PII sweep, gitleaks CI, `loop-engine` bin +
  tests migrated unmodified, `claude plugin validate --strict` green, one dogfooded `verdict-run`
  via `--plugin-dir`.
- **M1** — public release of `loop-engine`: English docs, `classify-risk` rule table externalized
  per-consumer, marketplace goes public (SHA-pinned channel).
- **M2** — `ship-flow` (the delivery-loop skill stack) + `templates/` (constitution-layer templates
  a setup skill wires into a consuming repo — a plugin's root `CLAUDE.md` is not loaded as project
  context, so this can't just be a file in the plugin).
- **M3 (optional)** — `loop-memory` (pgvector semantic lesson recall, opt-in / `defaultEnabled:
  false`) and a submission to `anthropics/claude-plugins-community`.

## License

MIT — see [LICENSE](LICENSE).
