# 0.6 → 0.7: deliberate store migration

0.7 changes trust and ownership semantics before 1.0. Installing a plugin update is not approval to
migrate, adopt, purge or reindex an existing database. Memory stays disabled by default; base loop
features remain usable while memory migration is reviewed. **Never run these commands against a
product DB, a shared mixed-repository DB, or an unknown endpoint.** There is no `adopt`/`force` bypass.

## Existing data

- An occupied DB without a `memory_store` identity returns `legacy_store_unowned`. Even an empty
  note table with an old operation ledger is occupied. Existing content-only HMAC rows are not trusted.
- A DB owned by another canonical checkout returns `store_owner_mismatch`. A changed provider/model
  returns `embedding_identity_mismatch`. Same dimensions do not make models interchangeable.
- A missing signing key returns `signing_key_missing` for writes and reads. No unsigned KB fallback.
- Run the complete reviewed chain using `npm run db:migrate`: `0002` adds tables/columns and
  `0003_signed_note_identity.sql` adds active signed-source uniqueness. `0002` alone is incomplete.
  Neither migration infers ownership nor deletes
  notes/logs. In particular it cannot separate a mixed old DB safely. Preserve it for separately
  approved review/export/retention; do not manually set `memory_store` to bypass these errors.

The supported recovery path is a **fresh dedicated store** and graduation from reviewed repository
sources. Do not copy old DB vectors, signatures, `memory_store`, or unverifiable `verified:true` flags.

## Concrete fresh-store procedure

The following is an example for repository `example-app`, using a deliberately new compose project
and an operator-selected unused local port. Replace both names for your repository; do not reuse the
old project's name or stop its container. Docker is only one optional way to supply Postgres+pgvector.
An independently provisioned empty dedicated pgvector DB works with the same migration and CLI steps.

```sh
# In the loop-memory source/development package (dependencies installed beforehand):
cd /absolute/path/paul-loop/tools/loop-memory
export LOOP_MEMORY_COMPOSE_PROJECT=example-app-memory-v07
export LOOP_MEMORY_PORT=55434
npm run db:up
export LOOP_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55434/loop_memory
npm run db:migrate
```

`db:up` is an explicit infrastructure action; check the selected project/port before running it. The
compose helper binds loopback only and has no fixed global `container_name`. The old global project
`loop-memory-plugin` is not renamed, stopped, or removed. Do not run `db:down` against the old project
as part of this procedure. For a non-Docker DB, provision pgvector and an empty database explicitly,
set its URL instead, then run `npm run db:migrate` in the package. Schema generation is not migration.

Configure the **consumer repository**, from its canonical checkout. Use plugin sensitive userConfig
or the gitignored `.loop/.env`. Ensure `.loop/.env` is ignored and mode 0600 before putting secrets in
it. Example entries (replace placeholders; never commit the actual file):

```dotenv
LOOP_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55434/loop_memory
LOOP_EMBED_PROVIDER=openai
LOOP_EMBED_MODEL=text-embedding-3-small
OPENAI_API_KEY=<your OpenAI embedding credential>
LOOP_MEMORY_SIGNING_KEY=<a new random secret, e.g. openssl rand -hex 32>
```

For Gemini use `LOOP_EMBED_PROVIDER=gemini`, `LOOP_EMBED_MODEL=gemini-embedding-001`, and
`GEMINI_API_KEY`. Do not paste the `openssl` command as the key value; run it separately and securely
store its output. Keep the signing key private to this repository's memory ingestion boundary.
Shell variables, including explicit empty strings, override userConfig/dotenv. If a stale exported
URL/key/provider overrides the new file, unset that variable in the invoking shell. Never print keys
or full connection strings into logs. Both credentials may exist, but provider selection must be
explicit in that case. Model defaults are resolved into a stable identity at first binding.

Review the sources and then explicitly graduate (this sends sanitized source text to the configured
embedding provider and writes the new store):

```sh
cd /absolute/path/example-app
# This directory is the one authoritative lesson snapshot, even when it starts empty.
mkdir -p .loop/lessons
node /absolute/path/loop-memory/dist/cli.js graduate --json
# Optional, explicitly selected knowledge sources; omit flags that do not apply:
node /absolute/path/loop-memory/dist/cli.js graduate --json \
  --knowledge docs/adr --context CONTEXT.md --research docs/research
node /absolute/path/loop-memory/dist/cli.js stats --json
printf '%s' 'a non-sensitive example query' | \
  node /absolute/path/loop-memory/dist/cli.js recall --query-stdin --json
```

First writable access binds only a truly empty store. Require `outcome:"synced"` before claiming the
snapshot is current; `locked`, `partial`, `skipped`, and `error` are different outcomes. Unsupported-only
input does not delete a corpus and reports incomplete. A present empty canonical source directory
can retract that source's existing corpus. Missing/unconfigured sources do not authorize a full purge.
Use root-relative source paths within the canonical repository. Feature worktrees read the canonical
owner’s store and dotenv fallback, but cannot graduate branch snapshots over it.

If running from a packaged installation, point the commands at that installation's `dist/cli.js`.
For source development, rebuild with `npm run build` after source changes. Do not rebuild an installed
plugin in place as part of repository setup.

## Linked-worktree receipt retention

The DB owner is the canonical git-common checkout, but a verifier receipt belongs to the **actual
real execution root**. These identities serve different purposes. This release has no receipt
transfer/adoption command and no transparent post-merge learning from a deleted feature worktree.
A genuine feature-worktree lesson remains verifiable there while its original worktree path, lesson,
producer seal and FAIL/PASS receipts remain available. Copying all those files to the canonical
checkout (even in the same Git repository), another clone, or a renamed checkout does not transfer
verification. Canonical graduation rejects that history as unverified.

Retain a feature worktree and its evidence if continued local verification of that history matters.
Before cleanup, separately decide whether to retain it as historical documentation. Canonical
graduation requires a genuine failure/fix/PASS pair recorded by the producer in the canonical
checkout; if reproducing the historical failure is no longer appropriate, keep the lesson historical.
Do not rewrite root hashes, fabricate seals, or infer a transfer approval from a merge/acceptance.
Future transfer would need an explicit producer-bound contract and separate review; it is not
implemented by this migration. The integration fixture exercises both original-worktree acceptance
and rejection after copying complete evidence and cleaning up that worktree.

## Existing lessons and new evidence

Old file lessons remain available as historical/unverified records. They will not automatically
become verified recall/promotion material in 0.7. Knowledge documents may be re-graduated after source
review; valid note signatures do not turn their prose into verified facts.

For a lesson, reproduce the failure and perform the actual implementation fix under the ordinary
verdict-run/loop-fix workflow. FAIL and PASS must be from the same command, run, and real worktree,
with no target drift during each check and an implementation change between them. The engine emits
receipts in `${LOOP_DIR:-.loop}/evidence`. Once a genuine pair exists:

```sh
node /absolute/path/loop-engine/bin/lessons.mjs record \
  --signature-file /path/to/preserved-fail-verdict.txt \
  --failure-receipt .loop/evidence/<FAIL-id>.json \
  --receipt .loop/evidence/<PASS-id>.json --verified \
  --fix 'description of the actual fix' --gate 'the verifier command'
```

The signature file must match the FAIL receipt's exact emitted bytes, including its final newline.
Recording also emits a protected producer seal binding this lesson's content to that pair. Keep the
seal and both original receipts in the same workspace's evidence directory; reads and graduation
revalidate them. A copied lesson history or recomputed summary does not acquire verification, and
summary-only records created during an unreleased hardening build must be recorded again through the
validated producer with their original genuine evidence. Missing evidence means historical/unverified.
Do not manufacture receipts for migration or edit a lesson's verification fields. A same-code flaky
retry is rejected. If the historical failure cannot be reproduced, retain the record as historical
and obtain human review for any guideline change; there is no automatic verified migration for it.
Re-graduate reviewed canonical lesson files afterward. Skeptic acceptance/codification remains a
separate approval boundary. Key rotation re-signs canonical content during graduation; changing the
embedding model or canonical clone identity uses a new empty store rather than mixing existing data.

Legacy DB raw payloads, deleted-note plaintext, copies, and backups are not scrubbed automatically.
Decide archival/export/deletion separately with the DB owner. 0.7 minimizes new payloads and scrubs
content when its own scoped lifecycle retracts a note. Sanitization is not a complete PII classifier.
For sensitive or held-out work use the controls in [HARDENING.md](HARDENING.md).
