# Changelog

Each plugin in this marketplace versions independently, following [semver](https://semver.org).
Explicit-version channel — see [README § Development status](README.md#development-status) for why
not a SHA channel. Entries below `## loop-engine 0.2.0` and earlier predate the multi-plugin split
and refer to `loop-engine` only (see the un-prefixed version numbers).

## loop-engine 0.4.1

- Fix: `plugin.json` no longer declares `"hooks": "./hooks/hooks.json"`. `hooks/hooks.json` is
  auto-discovered by convention — declaring it explicitly in the manifest made Claude Code load it
  twice (once by convention, once via the manifest field) and fail with "Duplicate hooks file
  detected", breaking every hook the plugin ships. Regression test
  `test/hooks-json-wiring.test.sh` updated to assert the field's *absence* (it previously asserted
  the opposite — the bug shipped in 0.4.0 with a passing test that locked it in).

## loop-engine 0.4.0

- Bundles 8 generic runtime-enforcement hooks via `hooks/hooks.json` (`plugin.json`'s new `hooks`
  field), so a consuming repo gets them on a plugin-version bump instead of hand-maintaining a
  local `.claude/hooks/` copy: `record-run-event` (run-ledger instrumentation across 7 events),
  `gate-stop-verdict` (Stop-hook fresh-PASS gate), `loop-doctor-heartbeat` (SessionStart
  self-diagnostic nudges), `protect-during-loop` (PreToolUse reward-hacking guard on
  `.loop/protect.globs` + the plugin's own install path), `gate-risky-commands` (PreToolUse
  merge/deploy REQUIRE mirror of `classify-risk`), `gate-before-merge` (PreToolUse direct-landing
  guard on protected branches), `gate-worktree-create` (PreToolUse origin/*-only worktree-base
  guard), and `warn-partial-checkout` (PostToolUseFailure partial-checkout data-loss warning).
  Ported from a consuming repo's local copy with three genericizations: (1) hooks now resolve
  their own sibling `lib/`/`bin/` files via `import.meta.url` instead of a cross-package plugin
  resolver, since they ship colocated in the same plugin package; (2) `gate-before-merge`'s
  protected-branch set now reads a consuming repo's `.claude/ship-flow.config.json`
  (`releaseBranch`/`integrationBranch`) instead of a hardcoded pair, falling back to `{main,
  master}` when that config is absent; (3) `loop-doctor-heartbeat`'s embedding-key/DB-URL check
  now bridges `CLAUDE_PLUGIN_OPTION_*` (loop-memory's own `userConfig` injection convention)
  instead of reading a hardcoded repo-local `.env` path. `ship-flow`'s `loop-engine` dependency
  bumped to `^0.4.0` accordingly. New regression test `test/hooks-json-wiring.test.sh` covers
  `plugin.json`/`hooks.json` structural wiring, an orphaned-file drift guard, an allow-path
  end-to-end smoke test for all 8 hooks, and a deny-path + config-driven-branch-set behavioral
  check for `gate-before-merge`.
- `docs/verdict-contract.md` updated — it previously said this plugin doesn't ship a Stop hook;
  now that it does, the doc points at `hooks/gate-stop-verdict.mjs`.

## loop-engine 0.3.0

- AC-level success contract gate — `bin/ac-verify.sh` (ADR-0006, #23): per-AC `verify:`/
  `artifacts:`/`expect:` contracts parsed from a plan file, judged by deterministic subprocess
  (reusing `verdict-run.sh` per AC), aggregated into one pass/fail. Composes with, doesn't replace,
  the observe-the-running-app check — zero contracted ACs on a runtime-surface plan is fail-closed.
- `bin/verifier-pinned-review.sh` + CODEOWNERS-based reinterpretation (#14): pins base-revision
  tests against self-weakening (bin/+test loosened together in the same PR), hardened through
  several adversarial rounds (TOCTOU close, CODEOWNERS-deletion-at-same-commit still caught,
  unresolvable BASE is a hard error rather than a silent PASS).
- `loop-fix --protect` hardened through six adversarial rounds: ground truth moved off tamperable
  on-disk files into process memory, restores a tampered/deleted protected file before aborting
  (not just detects it), now also runs the check on the PASS path (not just FAIL), a bounded
  grace-period recheck on both paths, and closes a watchdog-vs-grace-period race plus a
  VERDICT-RUN-ERROR abort gap.
- `lessons` hygiene: `invalidate`/`mark-clean` commands (#6), fail-closed `record --verified`
  without `--signature-file` (#9), FAIL-channel lesson auto-collection wired into `loop-fix` (#10),
  and a grounded-reopen convention (a retired lesson or rejected challenge needs a cited id + new
  evidence to reopen — a plain recurrence isn't reopening evidence).
- tier0 harness self-smoke gate (#7).
- ADR-0006/0007 (rationale for `ac-verify.sh` and loop-memory's manual-recall env sharing, ported
  upstream from a consuming repo — BAC-758) and a new `test/dangling-doc-refs.test.sh` regression
  guard against skill/doc examples pointing at consumer-repo-only paths (`tools/plugin-path.mjs`,
  `.claude/hooks/*`, `bin/loop-doctor.mjs`) as if this plugin ships them.

## ship-flow 0.2.0

- `publisher` subagent for ship-feature step 5 (#15): the Builder session — which has held
  untrusted issue/web content and full worktree access since step 0 — no longer runs the
  `git push`/PR-open/tracked-issue-comment itself. It hands off file-based title/body/comment text
  to a separate `publisher` agent instead, closing a heredoc-injection risk class (adversarial
  rounds closed a heredoc-to-variable handoff gap and a conflict-retry push gap).
- Grounded-reopen convention documented in `retrospect` (#9/#11): a retired lesson or rejected
  challenge needs a cited id + genuinely new evidence to reopen.
- Consumes loop-engine 0.3.0's `ac-verify.sh` (ADR-0006) — `ship-feature` step 1 plans now express
  AC contracts, step 3 runs `ac-verify.sh` against them.
- `retrospect`/`deps-audit` SKILL.md examples now disclaim that `tools/plugin-path.mjs` is a
  consuming-repo convention, not something this plugin ships (BAC-758 B7).

## loop-memory 0.2.1

- Fix: same `plugin.json` "hooks" field bug as loop-engine 0.4.1 — this plugin had the identical
  latent defect but it never surfaced because `defaultEnabled: false` means its hooks were never
  live-loaded by anyone yet. New `test/plugin-manifest.test.ts` locks the manifest shape so it
  can't regress once someone enables it.

## loop-memory 0.2.0

- Sleep-time consolidation batch (#12): dedup, decay-based ranking, promotion pre-scoring.
- Hook-fired graduate/recall writes now tag their source in `memory_op.payload.source`.
- ADR-0007 documenting why the manual `recall` CLI shares the hooks' env source and fails closed
  without an embedding key, rather than silently querying with a stub embedder (ported rationale,
  BAC-758).

## loop-memory 0.1.0 — M3 scaffold

- Initial extraction of `loop-memory` (pgvector semantic recall for verified lessons + optional
  ADR/glossary/research knowledge) from the origin monorepo, generalized: the worktree-scoped
  `.env`-file loading mechanism (`load-env.ts` and its hook counterpart) doesn't apply to a shared
  plugin install, so key/config sourcing moved to plugin `userConfig` (embedding keys and the
  signing key are `sensitive: true`, stored via the OS keychain) — hooks bridge Claude Code's
  `CLAUDE_PLUGIN_OPTION_<KEY>` injection into the plain env var names the CLI itself reads, keeping
  the CLI usable standalone too.
- Ships as a dependency-free `dist/cli.js` (esbuild bundle, drizzle-orm + pg included) — the hooks
  never touch `node_modules` at runtime, matching `loop-engine`'s "ships as a script" shape.
- Ships **`defaultEnabled: false`** at both `plugin.json` and the marketplace entry — installs
  disabled, verified via a real install-and-inspect against a local-scope marketplace copy.
- Knowledge-corpus sources (ADR dir / glossary file / research dir / design dir) are opt-in via
  userConfig with no default paths — the plugin makes no assumption about a consuming repo's doc
  layout unless explicitly pointed at one.

## ship-flow 0.1.0 — M2

- Initial `ship-flow` scaffold (`tools/ship-flow/`) registered in the marketplace, depending on
  `loop-engine`, with its first skill `hotfix` — lands an already-verified fix through worktree
  isolation → verify → PR → merge, with human confirmation checkpoints at merge and deploy.
- Review agent stack ported from glucofit-partners (ADR-0079/BAC-623): 4 self-owned agents
  (`planner`, `code-reviewer`, `test-hunter`, `verifier-integrity-hunter`) + 3 named workflows
  (`adversarial-review`, `harness-audit`, `trends-research`) — self-contained review capability, no
  external `pr-review-toolkit`-style dependency.
- `templates/` (CLAUDE.md constitution template, CI workflow template, branch-protection script, a
  turbo-verify wiring reference doc) + a `setup` skill that interviews a consuming repo's user and
  installs them — a plugin's own root `CLAUDE.md` isn't loaded as project context, so this can't
  just be a file sitting in the plugin.
- Remaining category-B skills ported and generalized: `grill-with-docs`, `retrospect`, `deps-audit`,
  `to-issues`, `to-prd`, `resolving-merge-conflicts`, `harness-maturity-audit`,
  `improve-codebase-architecture`, `tdd`, and `ship-feature` — the flagship plan-to-PR autonomous
  delivery loop and this plugin's single entrypoint. All glucofit-partners-specific pointers
  (`BAC-nnn`/`ADR-00nn` citations, hardcoded script/wrapper paths) replaced with either plain-prose
  descriptions or config-driven lookups (`.claude/ship-flow.config.json`'s `trackerName`, etc.).

## loop-engine 0.2.0 — M1 (public release)

- `docs/otel.md` and the remaining Korean prose in `docs/lessons.md` translated to English.
- `classify-risk.mjs`'s path/command rule table externalized: the plugin now ships with zero
  product-specific rules, loaded instead from `--rules <path>` / `CLASSIFY_RISK_RULES` / a
  `risk-rules.json` at the consumer's repo root. Structural baselines (docs-only, small-changeset
  AUTO, many-files, human-only-stage) still apply with no rules file present.
- New `test/classify-risk-rules.test.sh` covering the three injection channels and both error paths.

## 0.1.0 — M0 (private scaffold)

- Initial extraction of `loop-engine` (bin/lib/test) from the origin monorepo, unmodified except for
  removing what only made sense inside that repo (one hook with an external import, tests asserting
  on that repo's own CI/hook wiring, a fixture carrying real PR titles/paths).
- Secrets/PII sweep, `gitleaks` CI, `claude plugin validate --strict` green, one dogfooded
  `verdict-run` via `--plugin-dir`.
