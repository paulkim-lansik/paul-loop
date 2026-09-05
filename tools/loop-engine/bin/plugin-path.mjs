#!/usr/bin/env node
// Runtime-neutral path contract. A resolvable artifact is NOT proof of activation or hook trust.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const PLUGINS = {
  'loop-engine': { env: 'LOOP_ENGINE_PATH', minimum: '0.15.0' },
  'ship-flow': { env: 'SHIP_FLOW_PATH', minimum: '0.11.0' },
  'loop-memory': { env: 'LOOP_MEMORY_PATH', minimum: '0.7.0' },
};
const canonical = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };
const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000,
}).trim();
const versionParts = (v) => {
  const m = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z.-]+)?$/.exec(v ?? '');
  if (!m) throw new Error('expected a stable semantic version');
  return m.slice(1, 4).map(Number);
};
const older = (a, b) => { const x = versionParts(a), y = versionParts(b); return x[0] < y[0] || (x[0] === y[0] && (x[1] < y[1] || (x[1] === y[1] && x[2] < y[2]))); };

export function projectRoots(cwd) {
  let top = canonical(cwd);
  try { top = canonical(git(cwd, ['rev-parse', '--show-toplevel'])); } catch {}
  const roots = [top];
  try {
    const common = canonical(resolve(top, git(top, ['rev-parse', '--git-common-dir'])));
    // Only a main working tree with the same common git directory is eligible.
    const main = dirname(common);
    if (canonical(resolve(main, git(main, ['rev-parse', '--git-common-dir']))) === common &&
        canonical(git(main, ['rev-parse', '--show-toplevel'])) === main && !roots.includes(main)) roots.push(main);
  } catch {}
  return roots;
}

export function validatePluginPath(path, { plugin = 'loop-engine', runtime = 'claude', version, minimum = PLUGINS[plugin]?.minimum } = {}) {
  if (!PLUGINS[plugin]) throw new Error(`unknown plugin: ${plugin}`);
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error(`${plugin}: plugin path must be absolute`);
  const root = realpathSync(path);
  if (!statSync(root).isDirectory()) throw new Error(`${plugin}: plugin path is not a directory`);
  const kinds = runtime === 'shell' ? ['claude', 'codex'] : [runtime];
  const file = kinds.map((k) => join(root, `.${k}-plugin`, 'plugin.json')).find(existsSync);
  if (!file) throw new Error(`${plugin}: ${runtime} manifest missing`);
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  if (manifest.name !== plugin) throw new Error(`${plugin}: manifest name mismatch`);
  versionParts(manifest.version);
  if (version && version !== manifest.version) throw new Error(`${plugin}: registry/manifest version drift`);
  if (minimum && older(manifest.version, minimum)) throw new Error(`${plugin}: requires >=${minimum}; found ${manifest.version}`);
  return { path: root, version: manifest.version, runtime, activation: 'unknown', hookTrust: 'unknown' };
}

export function resolvePluginInstallation({ pluginsFile, root = process.cwd(), plugin = 'loop-engine', env = process.env, runtime = env.LOOP_RUNTIME || 'claude' } = {}) {
  const cfg = PLUGINS[plugin];
  if (!cfg) throw new Error(`unknown plugin: ${plugin}`);
  if (!['claude', 'codex', 'shell'].includes(runtime)) throw new Error(`unsupported runtime: ${runtime}`);
  const checked = (p, source, version) => ({ ...validatePluginPath(p, { plugin, runtime, version }), source });
  if (env[cfg.env]) return checked(env[cfg.env], 'explicit-environment');
  const roots = projectRoots(root);
  // This is our documented, explicit artifact registry, not a guessed Codex cache layout.
  // Never scan global Codex settings, credentials, or another marketplace's derivatives.
  const registry = env.PAUL_LOOP_INSTALLATIONS || roots.map((r) => join(r, '.loop', 'plugins.json')).find(existsSync);
  if (registry) {
    const record = JSON.parse(readFileSync(registry, 'utf8'));
    if (record.schemaVersion !== 1 || record.runtime !== runtime) throw new Error('runtime registry schema/runtime mismatch');
    const entry = record.plugins?.[plugin];
    if (entry) return checked(resolve(dirname(registry), entry.path), 'explicit-registry', entry.version);
  }
  if (runtime !== 'claude') return null;
  const file = pluginsFile || join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'plugins', 'installed_plugins.json');
  if (!existsSync(file)) return null;
  let parsed;
  try { parsed = JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
  const entries = parsed?.plugins?.[`${plugin}@paul-loop`];
  if (!Array.isArray(entries)) return null;
  let match;
  for (const r of roots) {
    // Local wins over project at the same root. Main-root fallback never selects another project.
    match = entries.find((e) => e.scope === 'local' && e.projectPath && canonical(e.projectPath) === r) ||
      entries.find((e) => e.scope === 'project' && e.projectPath && canonical(e.projectPath) === r);
    if (match) break;
  }
  match ||= entries.find((e) => e.scope === 'user');
  return match ? checked(match.installPath, 'claude-registry', match.version) : null;
}

export function resolvePluginPath(options = {}) { return resolvePluginInstallation(options)?.path ?? null; }

// Node normally resolves the entrypoint symlink, but --preserve-symlinks-main keeps its URL.
// Accept either identity without changing argv or running the CLI during a plain import.
if (process.argv[1] && (import.meta.url === pathToFileURL(process.argv[1]).href || import.meta.url === pathToFileURL(canonical(process.argv[1])).href)) {
  const [command, ...args] = process.argv.slice(2);
  const usage = () => { console.error('Usage: plugin-path.mjs resolve [plugin] | inspect [plugin] | exec bin/<file> [args...]'); process.exit(2); };
  if (!['resolve', 'inspect', 'exec'].includes(command) || (command === 'exec' && !args[0])) usage();
  const plugin = command === 'exec' ? 'loop-engine' : (args[0] || 'loop-engine');
  if (!PLUGINS[plugin]) usage();
  try {
    const found = resolvePluginInstallation({ plugin });
    if (!found) throw new Error(`${plugin}@paul-loop not resolved; configure ${PLUGINS[plugin].env} or PAUL_LOOP_INSTALLATIONS. Installation, activation and hook trust require separate review.`);
    if (command === 'inspect') console.log(JSON.stringify(found));
    else if (command === 'resolve') console.log(found.path);
    else {
      if (!args[0].startsWith('bin/') || args[0].split(/[\\/]/).includes('..')) throw new Error('exec target must remain inside plugin bin/');
      const target = realpathSync(join(found.path, args[0]));
      const rel = relative(join(found.path, 'bin'), target);
      if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('exec target escapes plugin bin/');
      const interpreter = target.endsWith('.mjs') ? process.execPath : target.endsWith('.sh') ? 'bash' : null;
      const result = interpreter ? spawnSync(interpreter, [target, ...args.slice(1)], { stdio: 'inherit' }) : spawnSync(target, args.slice(1), { stdio: 'inherit' });
      if (result.error) console.error(`[plugin-path] ${result.error.code || 'spawn failed'}`);
      process.exit(result.status ?? 1);
    }
  } catch (error) { console.error(`[plugin-path] ${error.message}`); process.exit(1); }
}
