# Local OTel Collection (BAC-587) — Claude Code telemetry → 127.0.0.1 receiver → H2/C1/C2

The foundation for collecting Claude Code's OpenTelemetry telemetry **locally only**, to produce
harness metrics (H2·C1·C2). Principle: **no content payload ever rides the collection path, and
telemetry is never exported past loopback.** The machine gate only proves "the first hop's
destination is loopback + content flags off" — whether some other local listener is already squatting
on that port while our receiver is down isn't something the gate can check, so the port is pinned to a
repo-specific non-standard value (**44318**) to structurally block a silent cross (leak/merge) with
some other project's collector that happens to live on the standard 4318 (with external forwarding
configured). One check before starting the receiver: `lsof -iTCP:44318 -sTCP:LISTEN` (if something's
already listening, our receiver fails loudly with EADDRINUSE).
(Do not substitute a warning message for this — adding warning text is an anti-pattern the research
rejected.)

## Components

| Piece | Role | Locked by |
|---|---|---|
| `.claude/settings.json` `env` block | Claude Code process-scoped OTel config (shell-wide export forbidden) | consumer-repo hygiene test, if this repo has one† |
| `bin/otel-receiver.mjs` | OTLP/HTTP(json) receiver — **127.0.0.1-only bind**, zero-dep, 0 docker | `test/otel-receiver.test.sh` |
| `bin/otel-metrics.mjs` | `.loop/otel/*.jsonl` → H2/C1/C2 aggregation (read-only, missing data = INSUFFICIENT_DATA) | `test/otel-receiver.test.sh` |
| `bin/loop-doctor.mjs` OTEL row† | crit if any content flag is on (dashboard, read-only) | consumer-repo hygiene test, if this repo has one† |

† `loop-doctor.mjs` and its `otel-hygiene`-style test are not shipped by this plugin — they're a
consumer-repo convention (a repo-owned health-check script that reads this plugin's OTel config and
fails loudly on a content-flag misconfiguration). Build one if this repo wants that guardrail;
otherwise the `.claude/settings.json` env block and the content-flag discipline below still apply,
just without a standing machine check.

## Starting the receiver — opt-in (not started by default)

```sh
node tools/loop-engine/bin/otel-receiver.mjs        # 127.0.0.1:44318 (same as the endpoint in the settings env block)
LOOP_OTEL_PORT=<port> node tools/loop-engine/bin/otel-receiver.mjs   # override the port (change the endpoint too)
LOOP_OTEL_DIR=<dir>   node tools/loop-engine/bin/otel-receiver.mjs   # override the landing directory (default .loop/otel/)
```

- Landing spot: `.loop/otel/<YYYY-MM-DD>.<kind>.jsonl` (`kind` = metrics|logs|traces). Not committed —
  covered by `.loop/*` in `.gitignore`. Every record passes `sanitizeRecord` from `lib/sanitize.mjs`
  before being written — but don't overstate what that buys you: OTLP's structure only has
  `key`/`value`/`stringValue` keys, so a key-name blocklist can't match anything, and the real effect
  is just **a length cap (truncate at 256 chars) + `key=value`-shaped secret masking**. The actual
  defense against content leaking is the hygiene gate (content flags off).
- **No retention policy (unbounded append)** — per-day files keep growing (export cycle 60s × 3
  signal kinds × session count). Delete old date files by hand: `rm .loop/otel/<YYYY-MM-DD>.*.jsonl`
  (or wipe everything with `rm -rf .loop/otel/`). Automatic rotation is a follow-up issue, same as
  always-on daemonizing.
- The receiver tags boundary surfaces (merge/deploy/send) **at record time (before truncation)** and
  attaches it to the span as `boundary_surface` — truncated stored text can't reliably tell
  merge/deploy tokens apart in a long command's tail (same principle as H1's record-time tagging).
  The aggregator trusts this tag first.
- **The receiver being down is a normal state** — a failed OTLP export from Claude Code is silent to
  the session (fail-open); it just means nothing gets collected. Always-on daemonizing (e.g. spawning
  on SessionStart) is out of scope (lifecycle/duplicate-start concerns — a separate issue).
- Non-JSON bodies (protobuf etc.) are recorded as-is with 200 + `unparsed:true` (to avoid a retry
  storm). The normal path is guaranteed by pinning `OTEL_EXPORTER_OTLP_PROTOCOL=http/json` in the env
  block.
- Aggregate: `node tools/loop-engine/bin/otel-metrics.mjs [--otel-dir <dir>] [--json]`

## H2 metrics table (AC ⑧)

| Item | Value |
|---|---|
| Exact span name | `claude_code.tool.blocked_on_user` |
| Meaning | **cumulative count over the collection window** of spans where a tool execution blocked waiting on human approval (not "per run" — the aggregator folds the whole directory, and parallel worktree sessions can converge on one receiver). The time window is `--since <ISO>`; session attribution is split out via `h2_by_session` (resource `session.id`). Per-run attribution is a follow-up consuming issue |
| 3 activation conditions | `CLAUDE_CODE_ENABLE_TELEMETRY=1` **+** `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1` **+** `OTEL_TRACES_EXPORTER` set |
| Exclusion | Spans matching a boundary surface (merge/deploy/send) are excluded from H2, but always flagged with `excluded_by_surface` — the exclusion list is the **same source** as H1 (single source: `lib/boundary-surfaces.mjs`). Without this exclusion, a "reduce human intervention" optimization would erase the human-approval boundary itself (ADR-0061 §5) |
| Send vocabulary | Merge/deploy tokens are universal; **send** is not — what an outbound call looks like is your repo's own vocabulary. Declare it as a regex string in `.claude/ship-flow.config.json` → `sendSurfacePattern`, and it is added as an extra `send` rule. Leave it unset and only the built-in tokens apply, which means **your** send commands are not excluded from H1/H2 — the boundary this row exists to protect stays exposed |

**Beta-dependency risk**: this span sits behind a beta flag (`CLAUDE_CODE_ENHANCED_TELEMETRY_BETA`).
Being honest about detection scope: `INSUFFICIENT_DATA` only appears when there are **zero trace
records** (trace export itself has stopped — beta/exporter not configured). A drift where traces keep
flowing but the target span alone disappears (e.g. a CC update renames the span) leaves H2 at 0, but
**`h2_reason` always carries "0 spans — cannot distinguish renamed from never-fired"**, and
`h2_span_seen` (the observed count before exclusion) makes the drift visible — never read a bare 0 as
"no waiting happened." C1 (sum of `claude_code.cost.usage` USD) and C2 (sum of
`claude_code.token.usage` by type) follow the same convention; metric names are verified by diffing
against the first real received payload — drift shows up as INSUFFICIENT_DATA there too.
**Temporality**: the env block pins `OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE=delta` (OTLP's
default, cumulative, resends the running total on every export — blindly summing would over-report by
a multiple of the batch count). The aggregator also defensively reads temporality: it sums `delta`
series and takes the per-series max for `cumulative`/unlabeled series (locked by a regression
fixture).
Consuming the H2/C1/C2 harness metrics (before/after comparisons etc.) is a follow-up issue — this one
covers the collection foundation + safeguards only.

## The 5 content flags — all forbidden (machine-enforced)

`OTEL_LOG_USER_PROMPTS` · `OTEL_LOG_ASSISTANT_RESPONSES` · `OTEL_LOG_TOOL_DETAILS` ·
`OTEL_LOG_TOOL_CONTENT` · `OTEL_LOG_RAW_API_BODIES` — never turned on, with any value.

- `OTEL_LOG_ASSISTANT_RESPONSES` gets **explicitly pinned to `"0"`** — it has no independent default,
  so leaving it unset falls back to `OTEL_LOG_USER_PROMPTS`, a documented trap (absence ≠ safe). The
  other 4 are unset=off by design, so they're deliberately left unwritten.
- `OTEL_LOG_RAW_API_BODIES` has a `file:<dir>` mode that dumps the raw, untruncated API body to disk
  with no network involved — this one flag alone implies exposure of the other 4. The canonical
  forbidden directory is `.loop/otel-raw/`, and `**/otel-raw/` was preemptively added to `.gitignore`
  so nothing that lands there gets committed no matter the path (defense in depth — turning it on at
  all is already forbidden).
- Monitoring: the OTEL row in `pnpm loop:doctor` inspects process env + the **3 settings files** (user
  `~/.claude/settings.json` < project `.claude/settings.json` < local `.claude/settings.local.json`,
  judged by CC's merge priority for the final effective value) and raises **crit** if even one is on.
  `local` is gitignored, so it's a blind spot the hygiene gate can't see — this dashboard is the only
  place watching it. **Limitation (stated honestly)**: run from inside a Claude session, the platform
  filters `OTEL_*` out of the Bash child's env, so the process-env arm goes dead (propagation measured
  below) — the shell-wide-export violation is only caught by running outside the session (`pnpm
  loop:doctor` in the user's own shell); the 3-settings-file check is where the real coverage is.

## Env scope — confined to the Claude Code process (AC ⑥·⑦)

Config lives in the top-level `env` block of `.claude/settings.json` (shell-wide export forbidden).
**Propagation measured (2026-08-09, Claude Code 2.1.226 — headless `claude -p` + Bash `printenv` + a
2-level node child, receiver not running)**:

- `CLAUDE_CODE_ENABLE_TELEMETRY`·`CLAUDE_CODE_ENHANCED_TELEMETRY_BETA` **are inherited** by the Bash
  child (values absent from the parent shell's baseline show up in `printenv` — also evidence that the
  env block actually takes effect).
- **`OTEL_*` variables were not inherited** by the Bash child or the 2-level child (0 `OTEL_` lines in
  `printenv`, and the 2-level node's `process.env.OTEL_METRICS_EXPORTER === undefined`) — the platform
  filters `OTEL_*` out of tool children's env. The leak surface we were worried about (a product
  `apps/api` boot inside a Claude session inheriting the exporter and product metrics flowing to the
  local receiver) is already closed at the platform level in this version.
- However, this filtering is **undocumented behavior** (version-dependent), so the discipline stays in
  place regardless: no shell-wide export, and when booting `apps/api` inside a Claude session use
  `env -u OTEL_METRICS_EXPORTER -u OTEL_LOGS_EXPORTER` (a defense-in-depth habit).
  `apps/api/src/tracing-sdk.js` pins both exporters with `??= 'none'`, and `??=` **lets an
  already-set value pass through** — this leak surface is locked by a regression test,
  `test/otel-env-scope.test.sh` (clean env → `none` / preset → passes through). For traces,
  tracing-sdk sets a NoopSpanProcessor explicitly, so there's no export path at all.
- A session with the receiver not running failed its export **completely silently** (0 bytes of
  stderr in the headless run) — a session doesn't get noisy in a shell with no collector (fail-open).
- The canonical path for QA/dev boots is the user's own shell in the main worktree (CLAUDE.md §8),
  which is outside the env block's reach.
- The exposure window is narrow — "Claude Code sessions started from this repo" — the alternative
  (shell-wide export) would make the whole machine the exposure window, which is why it was rejected.

## Out of scope, noted for the record

- A path that exports only aggregated metrics to PostHog (keeping the local-collector principle) was
  considered — a non-binding issue comment, not adopted in this implementation. Noted in the PR body.
- Before/after comparisons that consume H2/C1/C2 (the BAC-567·573 family) are a follow-up.
