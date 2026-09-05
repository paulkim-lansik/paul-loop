# Memory hardening contract

Memory remains **opt-in** (`defaultEnabled: false`). The base loop-engine / ship-flow plugin needs no
Postgres, embedding credential, or signing key. This document describes compatibility changes in
this hardening patch; these are local guardrails, not proof against an agent with unrestricted shell,
DB administrator privileges, or access to signing secrets.

## Evidence and learning

File lessons use loop-engine's shared `lesson-state.mjs`. A legacy `verified:true` flag or a verdict
text file alone is a historical claim, not new verification. New verified records require an immutable
local FAIL/PASS receipt pair validated by `readEvidence`, with the same real execution root, run and
verifier command hash. Each verification must leave its target unchanged; the implementation target
must change between FAIL and PASS. The FAIL output file's exact bytes must match `verdict_sha256`.
Stored summaries include both fix target digests. A checksum is an integrity guardrail, not a
cryptographic verifier attestation. Separate skeptic acceptance still controls codification.

`lessons record --verified` additionally writes an immutable `kind:knowledge`,
`purpose:lesson-verification` producer seal under the protected evidence directory. It binds the
lesson ID/content hash to the validated FAIL/PASS pair and its gate/iteration metadata. Every read,
promotion and graduation resolves that seal and both original receipt files in the current workspace;
missing evidence, copied foreign histories and recomputed summaries are unverified. Historical
workspace contents need not equal today's tree: the receipts prove their past stable FAIL/fix/PASS
targets, not a current verification. Authoritative lesson files must be protected alongside evidence.
This is not attestation against an actor permitted to rewrite protected files or invoke arbitrary
producer commands. Library readers can supply an explicit `root`; graduation uses the bound
canonical repository root. Do not infer that root from a lesson's untrusted fields.

Repeated deliveries and additional receipts from the same run do not add independent confirmations.
Changing title/fix/signature resets confirmations and acceptance/retirement. Promotion counts verified
runs, not unverified recurrences. Iterations-to-green uses verified receipt summaries only. Mark-clean
requires a subsequent PASS from a distinct run; it is an **observed later pass**, not proof that a lesson
was unnecessary or caused an improvement. Retrieval counts, similarity, recurrence, and a successful
regression suite do not establish causal learning gains. Held-out outcome comparisons are separate.
Clean PASS verification must start after the latest recorded recurrence and verified recovery.
Lifetime clean-run deduplication survives recurrence resets; replaying old PASS receipts cannot
rebuild a retirement-candidate streak.

## Store ownership and migration

One DB has one `memory_store` owner and one embedding identity. Owner is SHA256 of the canonical
checkout's real path (git common-directory parent for ordinary git worktrees). Separate clones and
moves have different identities. Worktrees share recall, but only the canonical checkout graduates.
The public library requires `bindStore(db, pool, context)` before operations; an unbound store fails.
CLI and hooks enforce the same binding before embedding or corpus mutation. This is not multi-tenant
RLS and is not safe as a database shared with product data or unrelated repositories.
Receipt execution-root identity is stricter than the shared DB owner: feature-worktree receipts are
not transferable to canonical graduation, even after merge. See the explicit retention/cleanup
limitation in [MIGRATION-0.7.md](MIGRATION-0.7.md). No transparent post-merge learning is claimed.

Apply the full reviewed migration chain with `npm run db:migrate`, including
`0002_memory_hardening.sql` and `0003_signed_note_identity.sql`, only to the intended dedicated memory DB.
Applying `0002` alone is incomplete: `0003` adds active signed-source uniqueness. Migration adds
owner/corpus/source/model/content-hash fields only. It does not delete or adopt existing rows. **An occupied unowned legacy DB is not automatically
adopted or cleared by runtime.** Follow [MIGRATION-0.7.md](MIGRATION-0.7.md) to create a fresh dedicated memory DB, migrate it, and re-graduate from
reviewed canonical sources with valid new evidence. Keep or explicitly dispose of the old DB under
your retention policy. Database backups/WAL and copies remain the administrator's responsibility.
A fresh truly empty DB binds atomically on first writable access; ownership races are serialized.
Do not change metadata manually to bypass owner/model checks.

Only `<canonical-root>/.loop/lessons` is accepted by CLI graduation. Configured knowledge sources must
resolve within that repository; symlink source files are refused. A valid empty directory or an ADR
whose final entries are superseded retracts that owner's corresponding corpus. An unrecognized
nonempty document errors; unsupported-only input reports incomplete instead of silently deleting or
claiming full sync. `<!-- loop-memory: empty -->` explicitly marks an intentionally empty document.
Unconfigured corpora are not synchronized. Reconfigure sources deliberately: each corpus represents
one authoritative snapshot, not an arbitrary partial subset.

Filesystem source reading and parsing happen **after** the corpus advisory lock is acquired. A
connection-delayed caller therefore cannot reinsert a snapshot read before another caller completed
invalidation/supersession. This covers lessons, ADRs, context and generic Markdown directories.
The low-level `syncKnowledge` reader callback has the same lock boundary. Its compatible array form
is an explicit caller-supplied snapshot, not proof of filesystem freshness; file adapters must pass
a reader. File changes after a locked snapshot remain inputs to the next successful synchronization.

The optional compose helper now requires a repository-specific `LOOP_MEMORY_COMPOSE_PROJECT`; it no
longer uses a global container name, and binds only `127.0.0.1:${LOOP_MEMORY_PORT:-5434}`. This does not
rename or stop any existing installation. Choose a separate port and DB URL for a separate repository.

## Model, configuration and signatures

CLI and hooks share `runtimeEnv`: explicit shell values (including empty) > plugin userConfig >
allowlisted dotenv entries. Default dotenv is `.loop/.env`; a missing worktree file may read the main
checkout's copy. An existing empty worktree file suppresses fallback. Control flags come from the
process environment, not dotenv, so held-out evaluation policy cannot be overwritten by source files.

`LOOP_EMBED_PROVIDER` is `openai` or `gemini`. An explicitly selected provider without its key fails;
there is no provider fallback. If both keys exist, select a provider. `LOOP_EMBED_MODEL` may override
the default model. Provider, resolved model, normalization version and dimensions form the stored
embedding identity; equal vector dimensions do not imply compatible embedding spaces. Changing the
identity requires deliberate reindexing in a fresh store. `--allow-stub` is an explicit deterministic
fixture option and cannot query a store bound to a real embedding model.

`LOOP_MEMORY_SIGNING_KEY` is required for all corpus writes and recall. HMAC binds owner, corpus,
source key, embedding identity and full content hash. Knowledge uses the same authentication as
lessons. Legacy content-only signatures and unsigned rows are not recalled. Graduation corrects
changed content and rotates signatures even when text is unchanged, including retired stubs. Until
refresh under a new key, previous signatures fail closed. A signed note proves its ingestion scope,
not factual correctness, confidentiality, or semantic usefulness. Recall still uses untrusted-data
framing. Changing keywords or tags does not change the authenticated source used for lifecycle logic.

## Privacy, outcomes and frozen evaluations

Recognizable credentials, authorization headers, email addresses, common phone/ID/card patterns and
URL credentials/query/fragment are redacted before embedding and persistence. Recall output is
sanitized again and bounded. Hook queries travel through child stdin, not command-line arguments.
Redaction does **not** classify arbitrary personal, medical or confidential prose. External embeddings
still transmit sanitized text to the configured provider; use `LOOP_MEMORY_OFF=1` for sensitive work.
New operation payloads contain only content hash/length, fixed source label, or recall ID/corpus/distance.
Unchanged sync does not append NOOP rows. Retraction scrubs note content, vector and metadata; it does
not merely hide plaintext behind `deleted_at`. Old DB rows/logs and backups are unchanged by migration; review their retention separately. Error/debug logs omit provider/DB error bodies.

`--json` graduate/recall emits `schema_version:1`, `command` and typed `outcome`. Recall is `ok` with
`lessons` and `knowledge` arrays. Graduate is `synced`, `locked`, `partial` or `skipped`; errors are
`error` with a fixed reason and nonzero exit. Locked/partial remains exit 0 for hook compatibility but
is not successful synchronization. Hooks reject malformed JSON even when the child exits 0. Hook
failure preserves the user's session and records a distinguishable liveness outcome when enabled.

- `LOOP_LEARNING_OFF=1`: block all lesson mutations and memory mutations.
- `LOOP_MEMORY_RECALL_ONLY=1`: memory reads only; no sync, initialization, recall counters, liveness or
  debug writes. Binding uses a read-only transaction and an existing owner/model; no advisory lock.
- `LOOP_MEMORY_OFF=1`: reject memory before any DB/API access. Base lessons are frozen separately by
  `LOOP_LEARNING_OFF`. These controls do not isolate native agent profiles; the evaluation adapter
  remains responsible for profile and workspace isolation.

## Validation

`npm test` is offline unit/process/mocked integration coverage. `npm run test:integration` refuses
collection unless `LOOP_MEMORY_TEST_DATABASE_URL` names a local `loop_memory_fixture_*` DB; it creates
and drops random per-file schemas there, and runs actual pgvector and CLI subprocess checks with
stub embeddings. Never point it at an existing application database. No API is required. To create and clean up a private Unix-socket-only cluster automatically, run
`LOOP_MEMORY_PG_BIN=/path/to/postgres/bin npm run test:postgres-fixture` with local PostgreSQL+pgvector
already installed (or omit the variable to use `pg_config --bindir`). It never reuses an existing
cluster. A dedicated
DB remains required only for this explicit integration lane and the optional memory plugin itself.

Run `npm run typecheck`, `npm test`, and `npm run build` for source and bundled CLI validation. Engine
lesson tests include `lessons-evidence-integrity.test.sh` and `lessons-retire.test.sh`; the BAC-580 probe
uses `tools/loop-memory` and prints a separate SKIP if optional tsx is absent.

The development dependency audit, bounded overrides and their compatibility checks are recorded in
[DEPENDENCY-AUDIT.md](DEPENDENCY-AUDIT.md). The disposable PostgreSQL runner also exercises the
supported `drizzle-kit migrate` command before its per-file integration schemas.
