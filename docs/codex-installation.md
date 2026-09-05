# Generated local Codex installation

This installer distributes the generated paul-loop Codex packages to a durable **local marketplace**.
It uses the existing `paul-loop-codex` catalog and ordinary official CLI commands to install
`loop-engine` and `ship-flow`. It does not depend on any consumer repository or consumer-specific
marketplace. The packages keep their exact source release versions.

This is **not a public Git-native marketplace snapshot**. Do not pass the provider Git URL to
`codex plugin marketplace add` and expect its ungenerated source tree to work as this marketplace.
Installation evidence is not native hook/session end-to-end qualification.

## Clone, review, generate, plan, apply

Requirements: Node 22, Git for the explicit generation step, a compatible official Codex CLI
(`plugin marketplace list/add --json`, `plugin list/add --json`; tested with 0.146.0), and a local
filesystem with POSIX modes and same-parent directory rename support. Use a directory that will
remain available after the checkout/build is moved or deleted. Avoid temporary, network, synced,
or installed-cache directories. The installer cannot determine a volume's durability for you.

```bash
git clone https://github.com/reach0908/paul-loop.git
cd paul-loop

# Review the provider revision and its source packages before running its generator.
git rev-parse HEAD
git status --short
node scripts/generate-runtime-packages.mjs
node scripts/generate-runtime-packages.mjs --check

# Explicitly create only the parent. The installer must create its own marketplace directory.
mkdir -p "$HOME/local-marketplaces"

# Default is also plan. No files are written and Codex is not invoked in either form.
node scripts/install-codex.mjs \
  --build "$PWD/build/runtime-packages" \
  --marketplace-dir "$HOME/local-marketplaces/paul-loop-codex" --plan

# Apply only after reviewing the reported source commit, versions and destination.
node scripts/install-codex.mjs \
  --build "$PWD/build/runtime-packages" \
  --marketplace-dir "$HOME/local-marketplaces/paul-loop-codex" --apply
```

`--build` names the generated **parent** containing `.paul-loop-generated.json`, `provenance.json`,
`codex/` and `claude/`. It is not the `codex/` subdirectory. The installer never pulls Git, runs
the generator, executes a release script, reads credentials, or searches for another release.
An intact copied/relocated generated build and a standalone copy of the installer also work.

All supplied paths and their ancestors must be free of symlinks and traversal components. On
macOS, `/tmp` and `/var` can be aliases: supply physical paths (for example, obtain the parent
with `pwd -P`). A destination parent must already exist. An existing destination, even an empty
directory, must have this installer's valid ownership receipt; there is no `--force` or adoption
option. Build and destination trees must not overlap.

Plan prints JSON with the source commit, exact core versions, publication action and command
arguments. Marketplace registration and existing activation are **unchecked until apply**: invoking even a
listing command can create Codex state, so plan never runs it. Apply revalidates current files;
the printed plan is not a stored approval token or an immutable execution plan.

## What apply does

1. Validate the **entire generated file inventory**, including the Claude sibling and provenance,
   against SHA-256 and modes. Reject missing/unlisted files, unexpected empty directories,
   symlinks, special files/modes, invalid inventory paths, unsupported schema/adapter, changed
   marketplace identity, non-local catalog entries, unsafe installation policy, or manifest
   names/versions/repository identities that disagree with the expected provider and provenance.
2. Validate any existing owned destination against its prior installed inventory and recorded
   root. Check every file, including the optional memory payload and installer metadata. Stage
   the Codex tree, unchanged catalog, generated inventory, provenance, and an ownership receipt
   in a sibling directory. Preserve file modes; destination directory modes are 0755.
3. Only after preparation, run `codex plugin marketplace list --json`. A registration named
   `paul-loop-codex` must have the exact destination as both `root` and LOCAL `marketplaceSource`.
   Another name at that root, Git source, duplicate entry, different source/root, or unsupported
   CLI response stops the operation before publication. Registration alone never grants ownership
   of an absent or arbitrary directory. Then run `codex plugin list --json` to inspect installed
   core plugins. Any existing core must have a unique matching LOCAL identity, `installed: true`
   and `enabled: true`. A disabled or unknown state stops before destination publication and
   mutating CLI commands. No installed cores is a valid clean-install state; available catalog
   listings alone do not count as installed. This check also runs for initial registration so an
   orphaned installed core cannot be silently re-enabled.
4. Recheck staging and the old destination. For an update, rename the old directory to a unique
   retained sibling backup, then publish the staged directory with a rename. A caught publication
   failure restores the previous directory when the target is vacant. Identical inventory skips
   republication and creates no backup. Register an unregistered marketplace with the ordinary
   `codex plugin marketplace add <destination> --json`, then verify its LOCAL source/root again.
5. Run `codex plugin add loop-engine@paul-loop-codex --json`, then
   `codex plugin add ship-flow@paul-loop-codex --json`. Verify each returned identity and exact
   version, and compare the actual installed cache's complete file hashes/modes to the supplied
   payload. A bad response, missing file, stale cache, timeout or command failure stops dependent
   commands and returns failure. Finally, run `codex plugin list --json` again: both cores must
   report the installed source versions and `enabled: true`, preserving every existing enabled
   state. A disabled, missing, ambiguous or unknown post-install state is a failure. Success JSON
   includes the before/after activation observations. After the final CLI call, compare both
   complete installed caches again so a later installation cannot invalidate earlier evidence.

The copied generated catalog still lists optional `loop-memory`, because rewriting the catalog
would create a different artifact. This installer **never installs memory**, enables its database
infrastructure, copies project agent templates, edits project launchers, or changes hook trust.
The official CLI performs its normal registration and core plugin configuration; the installer
does not rewrite `config.toml`, force configuration overrides, set feature flags, or edit caches.
It uses the caller's current `CODEX_HOME` (or normal Codex default) only through those CLI commands.

## Updates and recovery

For a future update, explicitly obtain and review the intended provider revision, regenerate it,
then rerun the same plan/apply commands with the **same durable marketplace directory**. There is
no automatic pull or execution of an unknown release. Source release versions are copied exactly:
the installer never invents a cachebuster or version suffix. If the official CLI returns an old
cache, the hash comparison fails; resolve the reviewed source/release or CLI cache issue explicitly.

The destination has `.paul-loop-install.json`, which records the owning installer kind, provider
identity, destination root, source commit/versions, and installed inventory. It also retains the
original `.paul-loop-generated.json` and `provenance.json`. The copied generated marker still
describes both runtimes, while the receipt describes only the copied local marketplace and its
metadata; do not run the provider generator against this destination.

The ownership receipt intentionally binds the **destination**, not the location of the supplied
build or checkout. Moving the build is supported. Moving the owned marketplace or switching its
configured source requires an explicit separate migration; this installer does not silently
adopt the moved directory, rename the marketplace, or change its configured root.

| Error/state | Next action |
| --- | --- |
| Missing/tampered generated artifact | Regenerate the reviewed provider and rerun `--check`, then plan. |
| Unowned directory or source/root conflict | Choose a genuinely unused directory or inspect and explicitly resolve the conflicting CLI registration. Never manufacture a receipt. |
| Local edits, new files or mode drift | Preserve the edits outside the managed destination; restore its intact prior inventory before updating. No file is force-overwritten. |
| Existing core disabled or activation unknown | Keep the setting intact. Inspect `codex plugin list --json` and resolve the intended activation separately; the installer will not re-enable it or edit configuration. |
| Existing lock | Wait for the other installer. After a confirmed interrupted run, inspect the sibling stage/backup directories before removing the stale lock yourself. |
| Publication interruption | Preserve all stage/backup directories. If the destination is missing, restore the intact backup to its original recorded root before retrying. |
| CLI failure after publication | Read the error's completed-command list, retained destination and backup path. Inspect CLI state, then rerun the same installer. Configuration/cache changes are not automatically rolled back. |

The JSON success output reports the retained backup path. Backups are never pruned automatically.
Each rename publishes a whole directory, but the two-rename update and subsequent CLI operations
are **not one transaction**: a crash between renames can leave the root temporarily absent, and a
CLI failure can leave partial installation. The sibling lock serializes this installer only.
Keep other writers and consumers quiescent during updates; this is not protection against a hostile
concurrent writer, a forged inventory/receipt, or power-loss filesystem durability. SHA-256 and a
source commit establish local integrity/traceability, not authenticity, approval, or a signed release.

## Project launcher consumption

After installation, a consuming project can use the
[`scripts/project-plugin.mjs`](../scripts/project-plugin.mjs) launcher. Review and copy the launcher
into the project's `scripts/` and create a project `.codex/paul-loop.lock.json` with installed
identities and the **exact versions reported by this install**. For the source versions at this
guide's verification:

```json
{
  "schemaVersion": 1,
  "runtime": "codex",
  "plugins": {
    "loop-engine": {"id": "loop-engine@paul-loop-codex", "version": "0.15.0"},
    "ship-flow": {"id": "ship-flow@paul-loop-codex", "version": "0.11.0"}
  }
}
```

```bash
node /absolute/consumer/scripts/project-plugin.mjs --project /absolute/consumer doctor
```

Use the same Codex home for installation and launcher resolution. The launcher resolves installed
artifacts; the installer does not write that project lock, select a consumer project, set plugin
environment variables, or grant trust. Installed artifacts and project resolution are separate
from native hooks, new-task loading and live workflow success. Start a **new Codex task** for
runtime testing after installation/update; evaluate any required hook trust separately.

## Verification commands

```bash
node --test scripts/install-codex.test.mjs

# Optional real official CLI ingestion. All state is confined to a disposable HOME/CODEX_HOME.
PAUL_LOOP_TEST_REAL_CODEX=1 node --test scripts/install-codex.test.mjs
```

The normal suite uses a fake `codex` executable on PATH and actual installer subprocesses,
generated fixtures, filesystem copies, backups and cache checks. Targeted publication tests
inject OS rename errors inside the installer subprocess to exercise rollback and failed recovery. They do not
modify provider tests, the generator or any user installation. The opt-in test uses no credentials
or trust changes and is an ingestion check, not native session/hook E2E.

## Installer lane plan and acceptance review

Scope: `scripts/install-codex.mjs`, its dedicated CLI/filesystem tests, and this guide.
Project launcher changes, shared documentation and consumer rollout are outside this scope.

Plan reviewed before implementation (direct lane review, not an independent review):

1. Validate the supplied generated inventory, provenance, catalog and exact source versions.
2. Prepare a durable local marketplace with an ownership receipt; preserve edits and reject
   source/root identity changes. Publish a verified sibling staging directory with a retained
   backup for updates.
3. Only explicit `--apply` may invoke ordinary Codex marketplace/plugin commands. Default and
   `--plan` must perform no writes and start no subprocesses.
4. Exercise the executable with a fake Codex on PATH and disposable filesystem fixtures;
   optionally check official CLI ingestion in a fresh temporary `CODEX_HOME`.

| AC | Required evidence |
| --- | --- |
| AC1 | Missing/tampered/unlisted files, wrong modes/versions/names, unsafe paths and symlinks fail closed. |
| AC2 | Default/plan produce only a plan, including planned CLI commands, without filesystem or CLI effects. |
| AC3 | Apply copies the generated catalog unchanged and installs only engine/ship-flow at exact source versions. |
| AC4 | Existing targets require ownership and unchanged prior inventory; source identity/root conflicts preserve data. |
| AC5 | Updates retain an intact backup; preparation errors never invoke mutating CLI commands; partial CLI errors stay failures. |
| AC6 | A relocated generated build works without the original checkout; no pull, build execution, memory installation or trust edits. |
| AC7 | Disabled/unknown installed cores stop before publication or mutating CLI; clean install and verified enabled updates succeed, with enabled states verified by a final official plugin listing. |

Review decisions: generated hashes are integrity evidence, not a signature or release approval.
The installer consumes a previously reviewed build and never executes its contents. Copy the
existing generated catalog including its optional memory listing, but install only the two core
plugins. Do not add cachebuster/version suffixes. CLI registration and plugin installation are
separate from native session activation, hook trust and end-to-end qualification.

Activation-preservation follow-up review: ordinary `plugin add` can enable a previously disabled
installation. The installer therefore requires a pre-publication installed-plugin listing and a
post-install listing. It refuses disabled/unknown existing state rather than changing configuration.

## Lane evidence and final review — 2026-09-06

Verified with Node 22.19.0 and official `codex-cli 0.146.0`, using generated fixtures from provider
HEAD `d2d78c6ac91b9dc76fc5c387d01cc4fdea15847b`. The activation-preservation follow-up command was:

```bash
PAUL_LOOP_TEST_REAL_CODEX=1 node --test --test-reporter=spec scripts/install-codex.test.mjs
```

All **85 tests passed**, with zero failures or skips, including the opt-in official CLI test
(82.03 seconds). Syntax and whitespace checks passed for the three scoped files. Only the
installer suite ran for this follow-up; the full engine/core suite was not run.

| AC | Observed evidence |
| --- | --- |
| AC1 | Corrupted generated files, missing marker/provenance/files, modes, symlinks, inventory traversal, metadata collisions, catalog policy and manifest identity all rejected before destination/CLI effects. |
| AC2 | Default and explicit plan preserved complete fixture snapshots (bytes, modes, mtimes, inode identities); worked with no usable Codex on PATH. Existing-update plan also preserved state. |
| AC3 | Exact copied catalog and all Codex file hashes/modes matched; only the two core commands ran. Official CLI returned source versions 0.15.0/0.11.0 and its installed cache passed full inventory checks. |
| AC4 | Local file/mode/receipt edits were preserved; conflicting names, roots, LOCAL/Git sources and duplicate identities were rejected without mutating CLI commands. |
| AC5 | Prior backup retained its full snapshot; injected publication errors restored it. Failed rollback retained the backup and reported interruption. Partial CLI failure retained published state/backup and supported explicit retry. |
| AC6 | Relocated generated build and standalone installer succeeded. No original-build lookup, memory installation, credential/trust modification or consumer rollout was needed. |
| AC7 | Fake CLI tests rejected either disabled core, missing/null/nonboolean enabled state, missing installed state and ambiguous/source-unknown records before publication. Destination/cache/activation snapshots remained intact; only listing commands ran. Already-current apply also refused disabled state. Post-install disabled/unknown/missing/version-drift records failed. Official CLI initial install, whole-directory update with unchanged release versions, and replay all reported preserved enabled states. |

The official CLI test uses a fresh temporary home and lets official commands create its configuration;
it does not hand-edit configuration. Codex 0.146.0 exposes no plugin-disable subcommand, so a persisted
native disabled-state fixture was not created. A separate read-time disabled-state override probe
left the reported state enabled and configuration unchanged; it did not establish native disabled
state. Disabled-state refusal is proven at the fake-CLI/filesystem seam, while the official CLI
evidence covers clean installation and enabled updates. These checks do not prove native hook E2E.

Final review was a direct review within this lane; no independent review is claimed. Only the
three scoped files were authored. Generator, shared tests, CI, project launcher and consumer
installations were not edited by this lane. No commit or push was performed. Native session/hook
E2E, consumer activation and long-term workflow efficacy remain unverified by these tests.
