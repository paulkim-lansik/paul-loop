# Runtime packaging and compatibility

This source line declares loop-engine 0.15.0, ship-flow 0.11.0 and loop-memory 0.7.0.
The common core runs shell/Node commands. Runtime adapters package that core for a host; they do
not turn an instruction into a host capability. A successful schema check, generated artifact,
agent-eval grade or doctor result is not installation, hook trust, approval, isolation or native E2E evidence.

## Capability contract

The machine-readable contract is `tools/loop-engine/runtime/capabilities.json`.
`bin/runtime-doctor.mjs` checks artifact identity, Node/platform prerequisites and command availability,
then prints unresolved host activation/trust explicitly. `--require hooks` fails until the caller can
supply independent host evidence; this doctor deliberately cannot manufacture that evidence.

| Layer | Claude Code | Generated Codex | Other agent / shell |
|---|---|---|---|
| Core | Node >=22, Bash >=3.2, git, POSIX utilities; Linux/macOS | Same | Same; Windows requires a Linux/WSL environment |
| Verifier / fixer | Exit-code contract and explicit fix command | Same | Same; caller owns execution and approvals |
| Evidence / agent-eval | Local receipts, identity and grade fixtures | Same | Same; dataset cases are not native runtime coverage |
| Skills | Claude frontmatter and namespace | Agent Skills with compatibility contract; host-specific frontmatter removed | Reference instructions only |
| Review roles | Native `agents/*.md` | Role skills plus `agent-templates/*.toml` for deliberate project configuration | Caller must provide separate contexts and tool restrictions |
| Workflow JS | Host Workflow feature when enabled | Native JS unsupported; use a skill-documented equivalent fallback preserving gates and required independence | Caller provides a driver |
| Hooks | Native hook events when enabled | `hooks/hooks.json` plus per-plugin adapter; separate host trust required | None automatically |
| Patch protection | Edit/Write/MultiEdit and shell heuristic | Codex `apply_patch` payload parsed before classifying all targets | A caller can invoke the classifier; shell alone cannot intercept another agent |
| `PreToolUse` ask | Native review decision | Persistent deny; separate review alone does not make a retry pass | Caller decision boundary |
| Telemetry events | Source events | PermissionDenied, InstructionsLoaded and PostToolUseFailure omitted and visibly diagnosed | Caller-defined |
| Configuration | userConfig and environment | Explicit environment / allowlisted dotenv, dependency metadata | Explicit environment |
| Workflow cancellation | Host-dependent; hard cancellation not attested | No native hard cancellation claimed | Caller-owned |

Codex role templates are not silently copied into `.codex/agents/`. A role skill itself provides
neither fresh context nor a read-only sandbox. Configure the reviewed template only within approved
project scope, verify that the host actually created the intended isolated agent, and stop when
that required capability is missing. Publisher instructions retain separate publication approval.

Generated role skills rebase local Markdown resource links to their actual `skills/<role>/` location.
Native agent templates embed the shared authorization contract and its Markdown dependency closure;
publisher also includes the publish handoff contract. Their resource mapping uses in-document anchors,
so moving a template into a consumer's `.codex/agents/` does not break mandatory contract links.
Relative filenames in embedded prose are source labels; the caller supplies absolute paths for live
repository/configuration/artifact inputs. Generation validates local file links in all packaged skill
and agent Markdown, excluding code examples, external links and fragment-only links.

Reviewer/planner templates retain `sandbox_mode = "read-only"`. An investigation may authorize
necessary disposable fixtures, but the host must also permit that directory (for example `/tmp` or
`TMPDIR`). The read-only setting alone does not attest temporary write access. Check actual access,
keep audited/live/installed state unchanged, and never widen grants to bypass a denied fixture write.
Unavailable scratch access makes that check incomplete; independent authorized checks can continue.

A missing native Workflow does not stop the entire task. Follow a skill's documented direct-lane or
equivalent fallback when it preserves current authorization, required independence and gates. The
harness-maturity audit explicitly permits bounded direct lanes; this is not independent reviewer
proof. If no valid equivalent exists for a required capability, report that dependent step as blocked
and continue independent authorized preparation. Do not install tools or broaden grants as a fallback.

Codex `ask` recovery is deliberately limited: this adapter stores no approval, so an identical call
will be denied again even after separate human review. A human must use a supported, explicitly
authorized host execution/configuration route for that action. Do not promise an automatic retry,
silently disable hooks or use another tool to evade a denial. A native host approval facility, if
available and authorized, is separate from this adapter's static `ask` mapping.

For PreToolUse, empty/whitespace stdout is the documented defer form. Nonempty output must be one JSON
object with `hookSpecificOutput.hookEventName = "PreToolUse"` and an explicit allow/deny/ask decision.
Known optional fields are type-checked; malformed JSON, unknown fields/decisions, nondecision payloads,
wrong-event output and crashed guards deny with a diagnostic. Other hook events may emit plain context.
This bounded schema intentionally requires an adapter update for future protocol extensions.

Workflow call/concurrency/deadline budgets and late-output rejection bound accepted orchestration
results. They do not prove that a timed-out remote task stopped executing. Actual cancellation is
a host-adapter capability and needs independent testing. Hook process timeouts are a different boundary.

## Installation resolution

Set `LOOP_RUNTIME=claude|codex|shell`. `bin/plugin-path.mjs resolve [plugin]` returns a validated
absolute artifact root; `inspect [plugin]` adds version/source and unknown activation/trust fields.
`exec bin/<file> [args...]` dispatches an engine command preserving argv, cwd and exit status;
paths and symlinks escaping `bin/` are rejected.
The CLI recognizes both the supplied file URL and its physical target, including symlink entrypoints
with or without Node's `--preserve-symlinks-main`. Importing it does not dispatch the CLI.

Resolution order:

1. Explicit `LOOP_ENGINE_PATH`, `SHIP_FLOW_PATH`, or `LOOP_MEMORY_PATH`. Absolute directory,
   expected manifest type/name and stable version are required. Invalid overrides stop with an error.
2. Explicit `PAUL_LOOP_INSTALLATIONS` file, then the current project's `.loop/plugins.json`.
   For a linked git worktree, its own entry precedes the same repository's main-worktree entry.
3. Claude only: `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/installed_plugins.json`.
   Exact local scope precedes project scope, then the same repo's main worktree, then user scope.
   An unrelated project's registration is never a fallback.

Codex does not guess private cache layout or scan global host settings. An explicit registration is
an artifact mapping, not an enable/trust registry. A compatible Codex manifest is required for a
Codex override; a Claude-only source directory is rejected. Plain shell accepts either manifest.

```json
{
  "schemaVersion": 1,
  "runtime": "codex",
  "plugins": {
    "loop-engine": {"path": "/absolute/reviewed/artifact/loop-engine", "version": "0.15.0"},
    "ship-flow": {"path": "/absolute/reviewed/artifact/ship-flow", "version": "0.11.0"}
  }
}
```

Relative entry paths resolve from the registry file's directory. Generated `plugins.example.json`
works at its generated location; moving it to `.loop/` requires updating its paths. Registering a
review artifact does not install it. Do not silently activate optional loop-memory.

From the repository, an offline read-only probe is:

```bash
LOOP_RUNTIME=shell LOOP_ENGINE_PATH="$PWD/tools/loop-engine" \
  node tools/loop-engine/bin/runtime-doctor.mjs
```

The delivery configuration keeps `.claude/ship-flow.config.json` as a shared compatibility filename,
including in Codex. Existing hooks read that path. Generated constitution references use `AGENTS.md`;
this does not rename or modify the consuming project's existing files. Generated skill examples use
explicit plugin-root inputs derived from the skill's absolute location; no Codex bin PATH injection
is assumed. The setup action resolves independently pinned engine/ship clones in a new temporary
directory for each invocation and exports paths only after both validate.

## Protection and authority

While armed by the existing branch/sentinel policy, the protection hook always covers `.loop/lessons/**`, `.loop/evidence/**`,
`.loop/lifecycle/**` (state, recovery backups and lease), `.loop/.execution-lease/**`, verdict-state,
stop-gate state, looping sentinel, protect.globs, plugin mappings and protect-compromised state.
`LOOP_DIR` adds the configured execution-state directory, including its `lessons/` tree. The actual
`LESSONS_DIR` environment override adds a lesson tree resolved from the hook payload cwd, including
absolute paths outside the checkout. Default trees remain protected. Both configured directories and
direct file-tool targets are checked through physical aliases. No `LOOP_LESSONS` registry exists.
These defaults do not require a consumer
to copy extra globs. `.loop/runs` and ordinary logs/metrics remain observation telemetry.

The hook only knows configuration delivered to its own process. A one-off producer `--lessons` flag
or an environment assignment inside a Bash command does not register that directory for future hooks;
custom consumers must pass `LESSONS_DIR` to the hook environment or declare matching protect globs.
Normal `node .../lessons.mjs record ...` execution remains available under the Bash heuristic. This
does not approve a fabricated `verified` summary: the owning producer/readers must independently
validate backing receipts and current lifecycle state. Unrestricted Bash can write arbitrary files;
the path guard is not attestation and does not replace those memory checks.

The Codex parser consumes the complete supported patch envelope, collects Add/Update/Delete paths
and both Move endpoints, resolves paths from payload cwd, and checks lexical and physical paths.
Missing input, ambiguous or unrecognized syntax, dangling aliases, failed protection inspection and
mixed patches touching a protected file deny the entire call. Tests use real hook subprocesses but
do not apply the patch: they establish the decision contract, not host enforcement.

This is a local guardrail, not cryptographic proof or a filesystem sandbox. The shell token heuristic
cannot fully interpret arbitrary Python/Node programs, indirect shell variables or all aliases.
A trusted caller can invoke lifecycle/evidence commands, and a process with filesystem authority can
bypass hooks. Existing bounded guard-off and sentinel priority remain intact. Required evidence must
still be checked against current workspace identity by the owning evaluator; telemetry is not authority.

## Generation and version drift

Run `node scripts/generate-runtime-packages.mjs` from the source checkout. It writes only under
`build/` and refuses unowned output directories and symlink escapes. It reads the repository source,
not installed plugin caches. The output contains Claude and Codex catalogs/packages, dependency
metadata, reviewed-agent templates, source hashes, versions, mode-aware file inventory and source
commit. Same source bytes, modes and commit produce the same output; there is no timestamp cachebuster.
`--check` verifies every generated byte, mode and inventory entry without rewriting output.
The generated source hash includes uncommitted changes; a HEAD SHA alone is not the artifact identity.

Source manifests and marketplace versions must agree. Ship-flow and loop-memory require engine
`^0.15.0`. The new resolver rejects engine <0.15.0, ship-flow <0.11.0, memory <0.7.0 and prereleases,
including older project derivatives. This is a deliberate pre-1.0 minor compatibility boundary:
review/rebuild/update a chosen consumer installation before selecting it; do not relabel an old cache.
Internal memory `package.json` is a private development package, not its plugin release version.

Source, generated artifact, installed artifact, loaded host and active hook trust are separate states.
The audit's Claude 0.12.1/0.9.1 registrations were project-scoped to Zine; they establish nothing about
other projects. Installed `zine-codex` versions with Codex suffixes are separate derivatives. This
generator neither overwrites them nor infers their runtime behavior from a version string.

After instruction edits finish, run `node scripts/refresh-skill-lock.mjs --write`, review the hash-only
lock diff, then `--check`. Upstream source/fork metadata stays intact. A lock refresh does not sync
upstream skill text. CI checks that lock and regenerates packages on each source change.

Memory hooks execute committed `dist/cli.js`. The audit rebuild matched the original bundle byte
for byte; the defect was missing CI drift detection, not an established stale bundle. CI now builds
and compares committed dist before smoke testing it. Tag creation depends on engine, memory,
packaging and secret checks at the same event SHA. This is a workflow definition, not evidence that
remote main protection or a release has run.

CODEOWNERS already covers all of loop-engine, including lib/runtime and evaluation graders. The added
external paths cover packaging scripts, ship-flow workflow drivers, setup/branch-policy templates,
and memory provenance/admission/recall implementations, hooks, consumed bundle and tests. The reviewer
owner and pinned runner are unchanged. The runner reads CODEOWNERS from the base revision, so expanded
coverage starts once these entries become a later review's base. It still pins the engine test suite;
this does not pin the memory suite or manufacture missing baseline tests for new functionality. It
also does not activate remote required checks or imply a native CODEOWNERS approval gate (ADR-0002).

## Verification matrix and remaining boundaries

| Check | Fixture / execution | Evidence boundary |
|---|---|---|
| Resolver | Real temp manifests and git worktrees, spaces/Unicode, overrides, wrong/stale versions, config-dir, traversal | Artifact resolution only |
| Hook protection | Real subprocess; Write/Edit/MultiEdit and patch add/update/delete/move, malformed input, aliases, authoritative/default/custom lesson paths; real lessons CLI fixture write | No native host tool enforcement observed; producer fixture writes only disposable state |
| Codex adapter | Ask/deny/crash/invalid-input and actual malformed-output subprocesses, env bridge, unsupported-event diagnostic | Host trust not inferred |
| Packaging | Deterministic bytes/modes, native manifest shape, missing/extra/altered inventory, self-contained hook paths, rebased/embedded role resources, local doc-reference validation | No installation |
| Executables | Source mode checks, direct bounded CLI processes with empty HOME and offline gh | No model/provider request |
| Setup | Actual action shell, stubbed clone transport, real resolver, two calls and failure cleanup | No clone/install in a consumer |
| CI portability | Linux/macOS × Node 22/24; pinned/latest Claude schema validation | Hosted matrix must still execute |
| Memory bundle | Rebuild versus committed dist plus no-key smoke | DB/model integration remains separate |
| Agent-eval | Dataset and grade fixtures supplied by core tests | Not native Claude/Codex coverage |

Native validation still needs a separately authorized project session: enable/trust chosen hooks,
observe actual payloads and deny behavior, confirm subagent isolation, verify Stop behavior, then
exercise cancellation only for a host that exposes it. No such live E2E or installation is asserted here.

## Native qualification observed 2026-09-05

All qualification commands below ran with temporary HOME/Claude config/Codex config directories;
no installed profile, hook trust, marketplace registration or plugin activation was modified.

| Actual tool | Observed command/result | Qualification limit |
|---|---|---|
| Claude Code 2.1.229 | `plugin validate --strict` passed source catalog + 3 plugins and generated Claude catalog + 3 plugins (8 targets) | Manifest validation only; no agent session |
| Codex CLI 0.146.0 | Top-level, plugin and marketplace help inspected; no manifest `validate` subcommand advertised | Did not install a package to force ingestion |
| Codex CLI 0.146.0 | Isolated default `features list`: hooks, multi_agent, plugins stable/true; plugin_hooks removed/false | Feature availability is not persisted hook trust or observed execution; removed plugin_hooks does not mean current hooks are absent |
| Local Codex plugin-creator schema validator | All 3 generated `.codex-plugin/plugin.json` packages passed | Separate static validator, not native CLI validation or live E2E |

Codex help exposes persisted hook trust as a separate boundary. No trust-bypass flag was used.
The active installed profiles and their trust states remain uninspected/unknown in this implementation
qualification. CI additionally defines Claude 2.1.261 (published version checked through npm metadata)
and latest schema jobs; those hosted jobs have not run as part of this local lane.

## Resolver regression migration self-review

`test/plugin-path.test.sh` still participates in the existing Bash suite and delegates to the Node
test file. The old shell assertions were compared to HEAD before replacement:

| Old contract | Retained in `test/plugin-path.test.mjs` |
|---|---|
| Missing/malformed/no-key/empty registry returns null | Missing/malformed/empty registry group |
| Single exact project match; multi-entry order cannot pick another project | Exact-project group includes both single and multi fixtures |
| User fallback; no blind first-entry fallback | Exact-project group |
| LOOP_ENGINE_PATH wins over an existing project registry | Validated override group with a conflicting real registry fixture |
| Separate sibling keys and SHIP_FLOW_PATH/LOOP_MEMORY_PATH; wrong engine env cannot leak | Independent sibling group, including a positive ship-flow registry match with a wrong engine override |
| mjs via Node, sh via Bash, executable via direct exec | CLI dispatch group; mjs fixture is non-executable, sh fixture requires Bash syntax |
| Named missing-install exit 1; missing argument/unknown plugin exit 2 | CLI dispatch group, including loop-memory stderr |
| CLI default engine and explicit ship-flow resolution | Positive CLI dispatch assertions |
| Relative CLI module path with spaces and a real temp Git repo must execute | Copied `./plugin-path.mjs` fixture; named exit 1 retained |
| Empty override plus isolated HOME cannot use the real installed registry | CLI fixture uses an empty HOME and explicit environment |

The intentional changed contract is validation: old fixtures returned nonexistent `/cache/...` and
`/env/...` strings without checking them. New fixtures create actual manifest directories; separate
negative cases reject missing paths, wrong names/runtime, prereleases, old versions and registry drift.
That behavior change is the authorized installation-hardening fix, not a removed test expectation.
The new cases additionally cover local scope, CLAUDE_CONFIG_DIR, linked worktrees, physical aliases,
Codex explicit mappings, spaced/Unicode argv, cwd/child exit status and executable traversal rejection.

## Primary references checked 2026-09-05

- [Claude plugin reference](https://code.claude.com/docs/en/plugins-reference): manifests, bin discovery and configuration.
- [Claude workflows](https://code.claude.com/docs/en/workflows): host-native Workflow JS.
- [Codex plugin packaging](https://developers.openai.com/plugins/build/plugins): native manifests and marketplace roots.
- [Codex hooks](https://learn.chatgpt.com/docs/hooks): hook trust, apply_patch payload, event support and unsupported ask.
- [Codex subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents): reviewed project-agent configuration.
- [Agent Skills specification](https://agentskills.io/specification): portable skill metadata, not a tool-enforcement mechanism.
