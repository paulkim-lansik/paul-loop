# Changelog

`loop-engine` versions follow [semver](https://semver.org). Explicit-version channel — see
[README § Development status](README.md#development-status) for why not a SHA channel.

## 0.2.0 — M1 (public release)

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
