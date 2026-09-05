import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, readFileSync, realpathSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { resolvePluginInstallation, resolvePluginPath } from '../bin/plugin-path.mjs';
const cli = fileURLToPath(new URL('../bin/plugin-path.mjs', import.meta.url));
const versions = { 'loop-engine': '0.15.0', 'ship-flow': '0.11.0', 'loop-memory': '0.7.0' };
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'plugin paths 한글 ')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (path, data) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, typeof data === 'string' ? data : JSON.stringify(data)); };
  const plugin = (id = 'loop-engine', runtime = 'claude', suffix = '', version = versions[id]) => {
    const path = join(root, `${runtime}-${id}${suffix}`); write(join(path, `.${runtime}-plugin/plugin.json`), { name: id, version }); return path;
  };
  const registry = join(root, 'claude/plugins/installed_plugins.json');
  const opts = { root, pluginsFile: registry, runtime: 'claude', env: {} };
  return { root, write, plugin, registry, opts, set: (entries, id = 'loop-engine') => write(registry, { plugins: { [`${id}@paul-loop`]: entries } }) };
}
test('missing/malformed/empty registry and unknown plugins fail without guessing', (t) => {
  const f = fixture(t);
  assert.equal(resolvePluginPath(f.opts), null);
  f.write(f.registry, '{invalid'); assert.equal(resolvePluginPath(f.opts), null);
  for (const data of [{}, { plugins: {} }, { plugins: { 'loop-engine@paul-loop': [] } }]) {
    f.write(f.registry, data); assert.equal(resolvePluginPath(f.opts), null);
  }
  assert.throws(() => resolvePluginPath({ ...f.opts, plugin: 'unknown' }), /unknown/);
});
test('exact project, local override, user fallback, no unrelated-project fallback', (t) => {
  const f = fixture(t), a = f.plugin(), b = f.plugin('loop-engine', 'claude', '-other'), u = f.plugin('loop-engine', 'claude', '-user');
  const entries = [{ scope: 'project', projectPath: join(f.root, 'other'), installPath: b }, { scope: 'project', projectPath: f.root, installPath: a }];
  f.set([entries[1]]); assert.equal(resolvePluginPath(f.opts), a);
  f.set(entries); assert.equal(resolvePluginPath(f.opts), a);
  f.set([...entries, { scope: 'local', projectPath: f.root, installPath: b }]); assert.equal(resolvePluginPath(f.opts), b);
  f.set([entries[0], { scope: 'user', installPath: u }]); assert.equal(resolvePluginPath(f.opts), u);
  f.set([entries[0]]); assert.equal(resolvePluginPath(f.opts), null);
});
test('validated overrides have priority; names, stable versions, floors and stale paths are enforced', (t) => {
  const f = fixture(t), path = f.plugin();
  f.set([{scope:'project', projectPath:f.root, installPath:f.plugin('loop-engine', 'claude', '-ignored')}]);
  assert.equal(resolvePluginPath({ ...f.opts, env: { LOOP_ENGINE_PATH: path } }), path);
  for (const invalid of ['relative', join(f.root, 'absent'), f.plugin('ship-flow'), f.plugin('loop-engine', 'claude', '-old', '0.12.1'), f.plugin('loop-engine', 'claude', '-pre', '0.15.0-rc.1')]) {
    assert.throws(() => resolvePluginPath({ ...f.opts, env: { LOOP_ENGINE_PATH: invalid } }));
  }
  f.set([{ scope: 'user', installPath: path, version: '0.14.1' }]);
  assert.throws(() => resolvePluginPath(f.opts), /drift/);
});
test('each sibling key and override is independent, and inspection does not claim trust', (t) => {
  const f = fixture(t);
  for (const [id, envName] of [['loop-engine', 'LOOP_ENGINE_PATH'], ['ship-flow', 'SHIP_FLOW_PATH'], ['loop-memory', 'LOOP_MEMORY_PATH']]) {
    const path = f.plugin(id);
    const found = resolvePluginInstallation({ ...f.opts, plugin: id, env: { [envName]: path } });
    assert.equal(found.path, path); assert.equal(found.hookTrust, 'unknown'); assert.equal(found.activation, 'unknown');
    f.set([{ scope: 'project', projectPath: f.root, installPath: path }], id);
    assert.equal(resolvePluginPath({ ...f.opts, plugin: id }), path);
  }
  const ship = f.plugin('ship-flow');
  f.set([{scope:'project', projectPath:f.root, installPath:ship}], 'ship-flow');
  assert.equal(resolvePluginPath({...f.opts, plugin:'ship-flow', env:{LOOP_ENGINE_PATH:'/wrong-engine-ignored'}}), ship);
  f.set([{ scope: 'user', installPath: f.plugin() }]);
  assert.equal(resolvePluginPath({ ...f.opts, plugin: 'ship-flow', env: { LOOP_ENGINE_PATH: '/not-for-ship-flow' } }), null);
});
test('CLAUDE_CONFIG_DIR and canonical linked-worktree identity resolve the main project registration', (t) => {
  const f = fixture(t), repo = join(f.root, 'main'), worktree = join(f.root, 'feature');
  mkdirSync(repo); execFileSync('git', ['init', '-q', repo]);
  execFileSync('git', ['-C', repo, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture']);
  execFileSync('git', ['-C', repo, 'worktree', 'add', '-qb', 'feature', worktree]);
  const path = f.plugin(); f.set([{ scope: 'project', projectPath: repo, installPath: path }]);
  assert.equal(resolvePluginPath({ root: worktree, env: { CLAUDE_CONFIG_DIR: join(f.root, 'claude') }, runtime: 'claude' }), path);
  const alias = join(f.root, 'alias'); symlinkSync(repo, alias);
  assert.equal(resolvePluginPath({ ...f.opts, root: alias }), path);
});
test('Codex uses explicit artifact registration, rejects Claude-only overrides, and reports unknown activation', (t) => {
  const f = fixture(t), path = f.plugin('loop-engine', 'codex');
  const registry = join(f.root, 'artifacts.json');
  f.write(registry, { schemaVersion: 1, runtime: 'codex', plugins: { 'loop-engine': { path, version: '0.15.0' } } });
  const opts = { root: f.root, runtime: 'codex', env: { PAUL_LOOP_INSTALLATIONS: registry } };
  assert.equal(resolvePluginPath(opts), path);
  assert.equal(resolvePluginPath({ ...opts, env: {} }), null);
  assert.throws(() => resolvePluginPath({ ...opts, env: { LOOP_ENGINE_PATH: f.plugin() } }), /manifest missing/);
  f.write(registry, { schemaVersion: 1, runtime: 'claude' });
  assert.throws(() => resolvePluginPath(opts), /runtime mismatch/);
});
test('CLI dispatch preserves cwd, spaced argv and exit codes; rejects escapes and missing installs', (t) => {
  const f = fixture(t), path = f.plugin();
  const env = { PATH: process.env.PATH, HOME: join(f.root, 'empty-home'), LOOP_ENGINE_PATH: path, LOOP_RUNTIME: 'claude' };
  f.write(join(path, 'bin/args.mjs'), 'console.log(JSON.stringify({argv:process.argv.slice(2),cwd:process.cwd()}));process.exitCode=7;');
  const run = (args, overrides = {}) => spawnSync(process.execPath, [cli, ...args], { cwd: f.root, encoding: 'utf8', env: { ...env, ...overrides } });
  assert.equal(run(['resolve']).stdout.trim(), path);
  const ship = f.plugin('ship-flow');
  assert.equal(run(['resolve', 'ship-flow'], {SHIP_FLOW_PATH:ship}).stdout.trim(), ship);
  const result = run(['exec', 'bin/args.mjs', 'a b', '한글', '']);
  assert.equal(result.status, 7); assert.deepEqual(JSON.parse(result.stdout), { argv: ['a b', '한글', ''], cwd: f.root });
  f.write(join(path, 'bin/hello.sh'), '[[ -n \"$1\" ]] || exit 9; printf "sh:%s" "$1"');
  assert.equal(run(['exec', 'bin/hello.sh', 'two words']).stdout, 'sh:two words');
  f.write(join(path, 'bin/hello.bin'), '#!/bin/sh\nprintf \"bin:%s\" \"$1\"');
  chmodSync(join(path, 'bin/hello.bin'), 0o755);
  assert.equal(run(['exec', 'bin/hello.bin', 'two words']).stdout, 'bin:two words');
  f.write(join(path, 'outside.mjs'), 'process.exit(0)');
  symlinkSync(join(path, 'outside.mjs'), join(path, 'bin/escape.mjs'));
  assert.equal(run(['exec', 'bin/escape.mjs']).status, 1);
  assert.equal(run(['exec', 'bin/../outside.mjs']).status, 1);
  assert.equal(run(['exec']).status, 2); assert.equal(run(['resolve', 'unknown']).status, 2);
  const missing = run(['resolve'], { LOOP_ENGINE_PATH: '' });
  assert.equal(missing.status, 1); assert.match(missing.stderr, /loop-engine@paul-loop/);
  const noMemory = run(['resolve', 'loop-memory'], { LOOP_ENGINE_PATH: '' });
  assert.equal(noMemory.status, 1); assert.match(noMemory.stderr, /loop-memory@paul-loop/);
  f.write(join(f.root, 'module space/plugin-path.mjs'), readFileSync(cli).toString());
  const moduleDir = join(f.root, 'module space');
  execFileSync('git', ['init', '-q', moduleDir]);
  execFileSync('git', ['-C', moduleDir, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture']);
  const copied = spawnSync(process.execPath, ['./plugin-path.mjs', 'resolve'], { cwd: moduleDir, encoding: 'utf8', env: { ...env, LOOP_ENGINE_PATH: '' } });
  assert.equal(copied.status, 1); assert.match(copied.stderr, /loop-engine@paul-loop/);
});

test('symlink CLI runs with default and preserved main URLs; imports never run the CLI', (t) => {
  const f = fixture(t), path = f.plugin(), alias = join(f.root, 'resolver alias 한글.mjs');
  symlinkSync(cli, alias);
  const env = { PATH: process.env.PATH, HOME: f.root, CLAUDE_CONFIG_DIR: join(f.root, 'absent-config'), LOOP_RUNTIME: 'claude', LOOP_ENGINE_PATH: path };
  for (const flags of [[], ['--preserve-symlinks-main']]) {
    const result = spawnSync(process.execPath, [...flags, alias, 'resolve'], { cwd: f.root, encoding: 'utf8', env });
    assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout.trim(), path);
    const missing = spawnSync(process.execPath, [...flags, alias, 'resolve'], { cwd: f.root, encoding: 'utf8', env: { ...env, LOOP_ENGINE_PATH: '' } });
    assert.equal(missing.status, 1); assert.match(missing.stderr, /loop-engine@paul-loop/);
  }
  const direct = spawnSync(alias, ['resolve'], { cwd: f.root, encoding: 'utf8', env });
  assert.equal(direct.error, undefined); assert.equal(direct.status, 0); assert.equal(direct.stdout.trim(), path);
  for (const argv of [[], [join(f.root, 'nonexistent-entry.mjs')], [process.execPath]]) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(cli).href)}); console.log('import-only');`, ...argv], { cwd: f.root, encoding: 'utf8', env });
    assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, 'import-only\n'); assert.equal(result.stderr, '');
  }
});
