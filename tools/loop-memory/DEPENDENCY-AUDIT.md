# Development dependency audit — 2026-09-05

Scope: this implementation package's runtime **and** development dependency graph, checked with
`npm audit --json` against the npm registry. The package remains private, version `0.1.0`; the plugin's
0.7 compatibility boundary is separate. No installed plugin, remote, application DB or model API was
changed or called. This is a registry advisory snapshot, not proof of absence of vulnerabilities.

## Findings and bounded upgrades

The initial audit reported **8 affected dependency entries**: 1 critical, 1 high, 6 moderate.
These include transitive propagation, not eight distinct exploit primitives. All affected paths were
development tools. The configured test/build commands do not expose a Vitest UI or esbuild/Vite dev
server, so the reported server attack conditions were not demonstrated in a shipped CLI.

| Affected tool | Advisory and exposure | Resolution in the lockfile |
| --- | --- | --- |
| Vitest 2.1.9 | [GHSA-5xrq-8626-4rwp](https://github.com/advisories/GHSA-5xrq-8626-4rwp): file read/execution when its UI server listens | Vitest 3.2.7; manifest requires `^3.2.6`, the first patched 3.x version |
| Vite 5.x | [GHSA-4w7w-66w2-5vf9](https://github.com/advisories/GHSA-4w7w-66w2-5vf9), [GHSA-v6wh-96g9-6wx3](https://github.com/advisories/GHSA-v6wh-96g9-6wx3), [GHSA-fx2h-pf6j-xcff](https://github.com/advisories/GHSA-fx2h-pf6j-xcff): dev-server traversal/Windows paths | Vite 6.4.3 via `^6.4.3` override, within Vitest's supported range |
| esbuild 0.24.2 and legacy 0.18.20 | [GHSA-67mh-4wv8-2f99](https://github.com/advisories/GHSA-67mh-4wv8-2f99): cross-origin access to its development server | Direct esbuild 0.25.12; Drizzle's `@esbuild-kit/core-utils` also resolves to this version |

Vitest's patched 3.x line and Vite 6 avoid requiring a newer Node runtime just to apply the security
patch. Validation here used Node 22.19.0. No Node 18/20 execution claim is made. Drizzle-kit stays
0.31.10. Its legacy `@esbuild-kit` loader is deprecated upstream and constrains an unpatched esbuild;
the narrowly scoped override changes only that loader's esbuild dependency. Remove/review it when
Drizzle removes the legacy loader. npm's suggested Drizzle downgrade and `audit fix --force` were not
used. tsx resolved to 4.23.12 within its existing declared range; its own esbuild is 0.28.2.

The override is a deliberate compatibility change. Both synchronous/asynchronous TypeScript
transforms were executed with the patched loader. `drizzle-kit generate` ran in a disposable source
copy and reported no schema changes; `drizzle-kit migrate` ran against a newly created, named
`loop_memory_fixture_*` database on a private Unix socket. Existing stores were never migrated.

## Verification

After a clean `npm ci --ignore-scripts`, both `npm audit --json` and
`npm audit --omit=dev --json` exited 0 with **0 vulnerabilities**. `npm ls esbuild vite vitest` exited 0
with no invalid dependency resolutions. The lockfile, not a local node_modules workaround, contains
the corrected graph. Build/test execution also confirms that the optional platform binaries work
with install scripts disabled.

- `npm run typecheck`: PASS.
- `npm test`: 16 files, 159 passed, 2 optional live embedding tests skipped. No model requests.
- `LOOP_MEMORY_PG_BIN=/opt/homebrew/opt/postgresql@17/bin npm run test:postgres-fixture`:
  migration CLI plus 7 files / 54 tests PASS; the disposable server was stopped and removed.
- `npm run build`: rebuilds the shipped `dist/cli.js`. The no-key bundle smoke check must return
  exit 1 / `outcome:error`, `reason:embedding_key_missing` before DB/API access.

The named fixture runner is development-only and requires an already installed PostgreSQL+pgvector.
It adds no base-plugin infrastructure prerequisite. Full engine/workflow integration is a separate
parent-owned gate; the memory lane's focused receipt, lifecycle, privacy, dotenv and lesson metrics
regressions do not replace it. Store migration/recovery is documented in
[MIGRATION-0.7.md](MIGRATION-0.7.md); behavioral boundaries are in [HARDENING.md](HARDENING.md).
