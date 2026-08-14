# Changelog

Each plugin in this marketplace versions independently, following [semver](https://semver.org).
Explicit-version channel — see [README § Development status](README.md#development-status) for why
not a SHA channel. Entries below `## loop-engine 0.2.0` and earlier predate the multi-plugin split
and refer to `loop-engine` only (see the un-prefixed version numbers).

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
