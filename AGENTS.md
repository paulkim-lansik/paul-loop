# paul-loop contributor map

This is the plugin provider repository. Consumer `.loop/` operational data and installed plugin
caches are separate from this source tree; do not infer consumer activation or long-term efficacy
from provider unit tests. Start with [README](README.md) and the relevant accepted [ADRs](docs/adr/).

Use the host's instruction hierarchy and the user's current authorized scope. Project guidance
does not grant additional permissions. Reuse approval for the same action/artifact; routine
reversible implementation and verification do not need a second confirmation. Preserve explicit
merge, deployment and sending boundaries. See the shared [authorization contract](tools/ship-flow/skills/AUTHORIZATION.md).

## Implementation map

| Area | Source | Contract |
|---|---|---|
| Inner loop | `tools/loop-engine/bin`, `lib`, `hooks` | [Lifecycle](tools/loop-engine/docs/loop-fix.md), [verdict](tools/loop-engine/docs/verdict-contract.md) |
| Workflow/skills | `tools/ship-flow/skills`, `agents`, `workflows` | Required ACs, complete reviews and concrete publication handoffs |
| Optional memory | `tools/loop-memory/src`, `hooks`, `dist` | Current lifecycle, repository/embedding identity and verified receipts |
| Runtime packages | `scripts/`, `tools/loop-engine/runtime` | [Compatibility](docs/runtime-compatibility.md) |
| Evidence/evals | `tools/loop-engine/lib`, `eval` | [Evidence graph](tools/loop-engine/docs/evidence-graphs.md), [agent evaluation](tools/loop-engine/docs/agent-evaluation.md) |

## Verification

Node 22 and Bash 3.2+ are the tested development baseline.

- Engine: `bash tools/loop-engine/test/run.sh`.
- Memory: from `tools/loop-memory`, run `npm ci`, `npm run typecheck`, `npm test`, `npm run build`.
- Validate rebuilt memory `dist/cli.js`, plugin manifests, generated runtime packages and vendor locks.
- Use focused regressions while implementing, then the relevant complete suite after integration.
- Never turn a missing check, timeout, unsupported runtime or RECORD operation into PASS.

Protect verifier behavior. When verifier/tests need a legitimate change, retain behavioral failure
coverage and explain the changed contract. A version bump or CI success is not merge approval.
Do not enable memory infrastructure or replace consumer plugin installations as a side effect of
editing this provider. Record work and evidence under `docs/audits/`; retain actual limitations.
