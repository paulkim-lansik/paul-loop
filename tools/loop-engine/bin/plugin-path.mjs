#!/usr/bin/env node
// plugin-path.mjs — resolves the on-disk root of a paul-loop plugin (loop-engine, ship-flow,
// loop-memory) for a consuming repo (BAC-753 — ported from glucofit-partners' repo-local
// tools/plugin-path.mjs, originally BAC-699/706/766). Bundled here so a repo with ONLY these
// plugins installed (no repo-local copy of its own) still has a working resolver, closing the
// dangling reference that upstream ship-feature/retrospect/deps-audit skills used to have when
// they hardcoded a consuming repo's own `tools/plugin-path.mjs` path.
//
// Two real jobs this script does that bare PATH resolution (a live session's plugin `bin/`,
// auto-registered on load) can't:
//   1. CI / any headless invocation outside a live Claude Code session — nothing is on PATH there,
//      so a caller needs a literal path. A consuming repo's CI clones the tagged plugin release
//      (this repo's own setup-loop-engine/setup-ship-flow composite actions, BAC-753) and sets the
//      env var below; this script picks it up.
//   2. Resolving a *different* installed plugin's path from within one plugin's own skill/hook —
//      e.g. a ship-flow skill needing loop-engine's install path, or anything needing ship-flow's
//      or loop-memory's path for a read (version check), since only loop-engine ships bin/ scripts
//      that land on PATH at all.
//
// Resolution order (per plugin):
//   1. An explicit env var override — LOOP_ENGINE_PATH / SHIP_FLOW_PATH / LOOP_MEMORY_PATH. CI sets
//      these after a pinned `git clone` (GitHub Actions is a plain shell process, outside the Claude
//      Code plugin-cache mechanism entirely — see docs/adr/0078 addendum in glucofit-partners). A
//      human can also point one at a local paul-loop checkout when working on a plugin itself.
//   2. ~/.claude/plugins/installed_plugins.json — the live Claude Code plugin cache, matched by
//      `projectPath === this repo's root` (via `git rev-parse --show-toplevel`), not blindly the
//      first array entry — a machine can have a plugin installed for several projects/worktrees at
//      different versions, and taking entries[0] could silently resolve a stale or wrong-project
//      install.
//
// No match anywhere is a loud failure (exit 1), not a silent fallback — a caller that swallowed this
// and proceeded without the harness would be worse than one that stops.
//
// Usage:
//   node plugin-path.mjs resolve [plugin]                     # print the resolved plugin root, or exit 1
//   node plugin-path.mjs exec <relative-bin> [args]            # resolve loop-engine, run <root>/<relative-bin>
// [plugin] defaults to loop-engine. `exec` only ever targets loop-engine: it's the only one of the
// three that ships bin/ scripts to run — ship-flow is skills/agents/workflows and loop-memory is
// hooks/a CLI of its own, both resolved by path only (`resolve <plugin>`, not `exec`).

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const PLUGINS = {
  'loop-engine': { key: 'loop-engine@paul-loop', envVar: 'LOOP_ENGINE_PATH' },
  'ship-flow': { key: 'ship-flow@paul-loop', envVar: 'SHIP_FLOW_PATH' },
  'loop-memory': { key: 'loop-memory@paul-loop', envVar: 'LOOP_MEMORY_PATH' },
};
const DEFAULT_PLUGIN = 'loop-engine';

function repoRoot() {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
}

export function resolvePluginPath({ pluginsFile, root, plugin = DEFAULT_PLUGIN } = {}) {
  const cfg = PLUGINS[plugin];
  if (!cfg) throw new Error(`[plugin-path] unknown plugin shorthand: ${plugin}`);
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: CI(setup-loop-engine/setup-ship-flow action)·로컬 모두가 명시적으로 세팅하는 리졸버 오버라이드(플러그인별로 이름이 다르다).
  if (process.env[cfg.envVar]) return process.env[cfg.envVar];
  const file = pluginsFile || join(homedir(), '.claude', 'plugins', 'installed_plugins.json');
  if (!existsSync(file)) return null;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  const entries = parsed?.plugins?.[cfg.key];
  if (!Array.isArray(entries) || entries.length === 0) return null;
  const projectRoot = root || repoRoot();
  const match =
    entries.find((e) => e.projectPath === projectRoot) ?? entries.find((e) => e.scope === 'user');
  return match?.installPath ?? null;
}

function usage() {
  process.stderr.write(
    'Usage: plugin-path.mjs resolve [loop-engine|ship-flow|loop-memory] | exec <relative-bin-path> [args...]\n',
  );
  process.exit(2);
}

function fail(plugin) {
  const cfg = PLUGINS[plugin];
  process.stderr.write(
    `[plugin-path] ${cfg.key}을 이 프로젝트에서 찾지 못했습니다. ` +
      `'claude plugin install ${cfg.key} --scope user -y'를 실행하거나(세션 재시작 필요), ` +
      `${cfg.envVar}를 로컬 paul-loop 체크아웃 경로로 설정하세요.\n`,
  );
  process.exit(1);
}

// import.meta.url is percent-encoded (spaces/non-ASCII → %XX); process.argv[1] is a raw OS path.
// Comparing them as strings silently mismatches on a checkout path containing either — the CLI
// block below then never runs, and this script exits 0 having done nothing (a caller like
// `pnpm verdict`/require-tests.sh would read that as success). pathToFileURL() normalizes argv[1]
// the same way before comparing (BAC-699 review, ported). 앞의 `process.argv[1] &&`는 argv[1]이
// 없는 맥락(`node -e`, 워커)에서 pathToFileURL이 던지지 않게 한다 (BAC-792).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'resolve') {
    const plugin = rest[0] || DEFAULT_PLUGIN;
    if (!PLUGINS[plugin]) usage();
    const installPath = resolvePluginPath({ plugin });
    if (!installPath) fail(plugin);
    process.stdout.write(`${installPath}\n`);
  } else if (cmd === 'exec') {
    const [relBin, ...args] = rest;
    if (!relBin) usage();
    const installPath = resolvePluginPath({ plugin: DEFAULT_PLUGIN });
    if (!installPath) fail(DEFAULT_PLUGIN);
    const target = join(installPath, relBin);
    const interpreter = target.endsWith('.mjs')
      ? process.execPath
      : target.endsWith('.sh')
        ? 'bash'
        : null;
    const res = interpreter
      ? spawnSync(interpreter, [target, ...args], { stdio: 'inherit' })
      : spawnSync(target, args, { stdio: 'inherit' });
    process.exit(res.status === null ? 1 : res.status);
  } else {
    usage();
  }
}
