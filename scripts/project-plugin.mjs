#!/usr/bin/env node
// Copyable project launcher. Host installation, native activation and hook trust are distinct.
import { execFileSync, spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ENV = { 'loop-engine': 'LOOP_ENGINE_PATH', 'ship-flow': 'SHIP_FLOW_PATH', 'loop-memory': 'LOOP_MEMORY_PATH' };
const stable = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z.-]+)?$/;
const identifier = /^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*@[a-zA-Z0-9_-]+$/;
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
const canonical = path => { try { return realpathSync(path); } catch { return resolve(path); } };
const stat = path => { try { return lstatSync(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
const inside = (root, file) => { const rel = relative(root, file); return rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel); };
const hostJson = (host, args, project) => JSON.parse(execFileSync(host, args, { cwd: project, encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }));

export function readLock(project) {
  project = realpathSync(project);
  const candidates = ['.codex', '.claude'].map(dir => join(project, dir, 'paul-loop.lock.json'));
  const matches = candidates.filter(path => { try { return statSync(path).isFile(); } catch { return false; } });
  if (matches.length !== 1) throw new Error('exactly one .codex/.claude paul-loop.lock.json is required');
  const path = matches[0], bytes = readFileSync(path), lock = JSON.parse(bytes);
  if (!inside(project, realpathSync(path))) throw new Error('lock escapes project');
  if (lock.schemaVersion !== 1 || !['codex', 'claude'].includes(lock.runtime) || !lock.plugins || Array.isArray(lock.plugins)) throw new Error('invalid lock schema/runtime');
  if (dirname(path) !== join(project, `.${lock.runtime}`)) throw new Error('lock runtime/location mismatch');
  if (!lock.plugins['loop-engine']) throw new Error('lock must include loop-engine');
  for (const [name, entry] of Object.entries(lock.plugins)) {
    if (!ENV[name] || !entry || !stable.test(entry.version)) throw new Error(`invalid plugin/version: ${name}`);
    if (entry.path !== undefined) {
      if (typeof entry.path !== 'string' || !entry.path || isAbsolute(entry.path) || entry.id !== undefined) throw new Error('vendored path must be relative and distinct from an installed id');
    } else if (!identifier.test(entry.id || '') || entry.id.split('@')[0] !== name) throw new Error(`invalid plugin identity: ${name}`);
    if (entry.scope !== undefined && (lock.runtime !== 'claude' || !['user', 'project', 'local'].includes(entry.scope))) throw new Error('invalid installation scope');
  }
  return { project, path, bytes, lock };
}

export function inspect(context) {
  const { project, path, lock } = context;
  const installed = Object.values(lock.plugins).some(p => p.id);
  if (installed && lock.runtime === 'codex') {
    const version = execFileSync('codex', ['--version'], { cwd: project, encoding: 'utf8', timeout: 30000 }).trim();
    if (!/^codex-cli (?:0\.146\.\d+|0\.153\.1)$/.test(version)) throw new Error(`unsupported Codex cache adapter version: ${version}; qualify the new host before running project commands`);
  }
  const raw = installed ? hostJson(lock.runtime, ['plugin', 'list', '--json'], project) : null;
  const listings = !installed ? [] : lock.runtime === 'codex' ? raw?.installed : raw;
  if (!Array.isArray(listings)) throw new Error('unsupported host plugin list response');
  const plugins = {};
  for (const [name, entry] of Object.entries(lock.plugins)) {
    let artifact, match;
    if (entry.path) {
      artifact = realpathSync(resolve(dirname(path), entry.path));
      if (!inside(project, artifact)) throw new Error('vendored plugin escapes project');
    } else {
      let matches = listings.filter(p => (p.pluginId || p.id) === entry.id);
      if (lock.runtime === 'claude') {
        matches = matches.filter(p => p.scope === 'user' || (p.projectPath && canonical(p.projectPath) === project));
        const scope = entry.scope || ['local', 'project', 'user'].find(s => matches.some(p => p.scope === s));
        matches = matches.filter(p => p.scope === scope);
      }
      if (matches.length !== 1) throw new Error(`missing or ambiguous installed plugin: ${entry.id}`);
      match = matches[0];
      if (match.version !== entry.version || (lock.runtime === 'codex' && match.installed !== true)) throw new Error(`installed version differs from lock: ${entry.id}`);
      const [plugin, market] = entry.id.split('@');
      // Codex 0.146/0.153.1 list omits installPath. This adapter is checked against the native
      // registration and real cache manifest. Never choose source.path or scan other versions.
      const cache = resolve(process.env.CODEX_HOME || join(homedir(), '.codex'), 'plugins/cache', market, plugin, entry.version);
      artifact = realpathSync(lock.runtime === 'codex' ? cache : match.installPath);
    }
    const manifest = readJson(join(artifact, `.${lock.runtime}-plugin/plugin.json`));
    if (!statSync(artifact).isDirectory() || manifest.name !== name || manifest.version !== entry.version) throw new Error(`cache/manifest identity drift: ${name}`);
    plugins[name] = { path: artifact, version: manifest.version, source: entry.path ? 'vendored' : entry.id, enabled: match?.enabled ?? null, scope: match?.scope ?? null };
  }
  return { runtime: lock.runtime, project, plugins, nativeHookTrust: 'not-checked' };
}

const json = value => JSON.stringify(value, null, 2) + '\n';
function registrySnapshot(context) {
  const path = join(dirname(context.path), 'paul-loop.plugins.json');
  if (stat(path)?.isSymbolicLink()) throw new Error('registry symlink rejected');
  return { path, bytes: existsSync(path) ? readFileSync(path) : null };
}
function unchanged(path, bytes) {
  if (stat(path)?.isSymbolicLink()) throw new Error('concurrent symlink conflict');
  if (bytes === null ? existsSync(path) : !existsSync(path) || !readFileSync(path).equals(bytes)) throw new Error('concurrent file conflict; host updates, if any, remain applied');
}
function registryDocument(snapshot, before, after) {
  const record = snapshot.bytes ? JSON.parse(snapshot.bytes) : { schemaVersion: 1, runtime: after.runtime, plugins: {} };
  if (record.schemaVersion !== 1 || record.runtime !== after.runtime || !record.plugins || Array.isArray(record.plugins)) throw new Error('registry schema conflict');
  for (const [name, artifact] of Object.entries(before.plugins)) {
    const entry = record.plugins[name];
    if (entry && (typeof entry.path !== 'string' || resolve(dirname(snapshot.path), entry.path) !== artifact.path || entry.version !== artifact.version)) throw new Error(`registry conflict: ${name}; review existing project mapping`);
  }
  for (const [name, artifact] of Object.entries(after.plugins)) record.plugins[name] = { path: artifact.path, version: artifact.version };
  return json(record);
}
function writableParents(context, snapshot) {
  for (const file of [context.path, snapshot.path, join(context.project, '.loop/plugin-updates/probe')]) {
    if (!inside(context.project, file)) throw new Error('configuration directory escaped project');
    let dir = context.project;
    accessSync(dir, constants.W_OK);
    for (const part of relative(context.project, dirname(file)).split('/').filter(Boolean)) {
      dir = join(dir, part);
      const info = stat(dir);
      if (info?.isSymbolicLink()) throw new Error('configuration/backup directory symlink rejected');
      if (info && !info.isDirectory()) throw new Error('configuration/backup directory is not a directory');
      if (info) accessSync(dir, constants.W_OK);
    }
    if (stat(file)?.isSymbolicLink()) throw new Error('configuration symlink rejected');
  }
}
function save(context, snapshot, before, after, nextLock = null) {
  const registry = registryDocument(snapshot, before, after);
  writableParents(context, snapshot);
  unchanged(context.path, context.bytes); unchanged(snapshot.path, snapshot.bytes);
  const changes = [{ path: snapshot.path, before: snapshot.bytes, after: registry }];
  if (nextLock) changes.push({ path: context.path, before: context.bytes, after: json(nextLock) });
  const changed = changes.filter(c => c.before?.toString() !== c.after);
  if (!changed.length) return;
  const backup = join(context.project, '.loop', 'plugin-updates', randomUUID());
  mkdirSync(backup, { recursive: true, mode: 0o700 });
  if (!inside(context.project, realpathSync(backup))) throw new Error('backup directory escaped project');
  for (const [i, change] of changed.entries()) {
    change.backup = join(backup, `${i}.before`);
    change.stage = join(backup, `${i}.new`);
    writeFileSync(change.stage, change.after, { mode: stat(change.path)?.mode & 0o777 || 0o600, flag: 'wx' });
  }
  try {
    for (const change of changed) {
      unchanged(change.path, change.before);
      if (change.before !== null) {
        // Retain the actual inode, including an edit that lands after the check. Never replace
        // an existing path with our new bytes; link is atomic and refuses a competing creation.
        renameSync(change.path, change.backup); change.moved = true;
        unchanged(change.backup, change.before);
      }
      linkSync(change.stage, change.path); change.published = true;
    }
    for (const change of changed) if (change.moved) unchanged(change.backup, change.before);
  } catch (error) {
    const recovery = [];
    for (const change of [...changed].reverse()) {
      try {
        if (change.published) {
          // Move the actual current inode before inspecting it. A pathname can be replaced
          // between any check and removal; retain that replacement instead of unlinking it.
          const displaced = change.backup + '.rollback';
          renameSync(change.path, displaced);
          try {
            unchanged(displaced, Buffer.from(change.after));
            const current = stat(displaced), staged = stat(change.stage);
            if (current?.ino !== staged?.ino || current?.dev !== staged?.dev) throw new Error('competing file replacement retained');
          } catch (conflict) {
            // No replacement: if another writer already recreated the path, both versions
            // remain recoverable and the outer diagnostic reports incomplete rollback.
            try { linkSync(displaced, change.path); } catch (restoreError) {
              throw new Error(`${conflict.message}; displaced file=${displaced}; restore=${restoreError.message}`);
            }
            throw conflict;
          }
        }
        if (change.moved) linkSync(change.backup, change.path);
      } catch (rollbackError) { recovery.push(`${change.path}: ${rollbackError.message}`); }
    }
    throw new Error(`${error.message}; retained backups=${backup}; rollback=${recovery.length ? 'INCOMPLETE: ' + recovery.join('; ') : 'restored previous files'}`);
  }
  for (const change of changed) rmSync(change.stage);
}

function update(context, before) {
  const snapshot = registrySnapshot(context);
  registryDocument(snapshot, before, before); // Detect local conflicts before shared host mutations.
  writableParents(context, snapshot);
  if (context.lock.runtime === 'codex' && Object.values(before.plugins).some(p => p.enabled !== true)) throw new Error('disabled/unknown Codex activation must be preserved; update it explicitly in the host first');
  const markets = [...new Set(Object.values(context.lock.plugins).map(p => p.id.split('@')[1]))];
  let gitMarkets = markets;
  if (context.lock.runtime === 'codex') {
    const available = hostJson('codex', ['plugin', 'marketplace', 'list', '--json'], context.project)?.marketplaces;
    if (!Array.isArray(available)) throw new Error('unsupported marketplace list response');
    gitMarkets = markets.filter(name => {
      const matches = available.filter(m => m.name === name);
      if (matches.length !== 1 || !['git', 'local'].includes(matches[0].marketplaceSource?.sourceType)) throw new Error(`missing/ambiguous marketplace: ${name}`);
      return matches[0].marketplaceSource.sourceType === 'git';
    });
  }
  const completed = [];
  const host = (args) => {
    unchanged(context.path, context.bytes); unchanged(snapshot.path, snapshot.bytes);
    const result = spawnSync(context.lock.runtime, args, { cwd: context.project, encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
    if (result.status !== 0 || result.error) throw new Error(`host command failed or outcome uncertain: ${args.join(' ')}; completed=${JSON.stringify(completed)}; inspect host state before retry`);
    completed.push(args);
  };
  for (const market of gitMarkets) host(['plugin', 'marketplace', context.lock.runtime === 'codex' ? 'upgrade' : 'update', market]);
  for (const [name, entry] of Object.entries(context.lock.plugins)) host(context.lock.runtime === 'codex'
    ? ['plugin', 'add', entry.id] : ['plugin', 'update', entry.id, '--scope', before.plugins[name].scope]);
  try {
    const native = hostJson(context.lock.runtime, ['plugin', 'list', '--json'], context.project);
    const installed = context.lock.runtime === 'codex' ? native?.installed : native;
    if (!Array.isArray(installed)) throw new Error('unsupported host response after update');
    const nextLock = structuredClone(context.lock);
    for (const [name, entry] of Object.entries(nextLock.plugins)) {
      const matches = installed.filter(p => (p.pluginId || p.id) === entry.id && (context.lock.runtime === 'codex' || (p.scope === before.plugins[name].scope && (p.scope === 'user' || p.projectPath && canonical(p.projectPath) === context.project))));
      if (matches.length !== 1 || !stable.test(matches[0].version) || matches[0].enabled !== before.plugins[name].enabled) throw new Error(`post-update identity/activation drift: ${entry.id}`);
      entry.version = matches[0].version;
    }
    const after = inspect({ ...context, lock: nextLock });
    save(context, snapshot, before, after, nextLock);
    return { ...after, completedHostCommands: completed };
  } catch (error) { throw new Error(`host updates applied but project synchronization incomplete: ${error.message}`); }
}

function main() {
  const args = process.argv.slice(2);
  let project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  if (args[0] === '--project') { if (!args[1]) throw new Error('--project requires a path'); project = resolve(args[1]); args.splice(0, 2); }
  const [command, target, ...childArgs] = args;
  if (!['doctor', 'exec', 'sync', 'update'].includes(command) || (command !== 'exec' && args.length !== 1)) throw new Error('Usage: project-plugin.mjs [--project DIR] doctor|sync|update|exec bin/<file> [args...]');
  const context = readLock(project);
  if (command === 'update' && Object.values(context.lock.plugins).some(p => p.path)) throw new Error('vendored plugins require their reviewed source updater; no files changed');
  const found = inspect(context);
  if (command === 'doctor') { console.log(JSON.stringify(found, null, 2)); return; }
  if (command === 'sync') { save(context, registrySnapshot(context), found, found); console.log(JSON.stringify(found, null, 2)); return; }
  if (command === 'update') { console.log(JSON.stringify(update(context, found), null, 2)); return; }
  if (typeof target !== 'string' || !target.startsWith('bin/') || target.split(/[\\/]/).some(p => p === '..' || !p)) throw new Error('exec target must remain inside plugin bin/');
  const bin = realpathSync(join(found.plugins['loop-engine'].path, 'bin'));
  if (!inside(found.plugins['loop-engine'].path, bin)) throw new Error('exec bin directory escapes plugin');
  const executable = realpathSync(join(found.plugins['loop-engine'].path, target));
  if (!inside(bin, executable) || !statSync(executable).isFile()) throw new Error('exec target escapes plugin bin/');
  const env = { ...process.env, LOOP_RUNTIME: found.runtime };
  for (const key of Object.values(ENV)) delete env[key];
  delete env.PAUL_LOOP_INSTALLATIONS;
  for (const [name, value] of Object.entries(found.plugins)) env[ENV[name]] = value.path;
  const interpreter = executable.endsWith('.mjs') ? process.execPath : executable.endsWith('.sh') ? 'bash' : executable;
  const result = spawnSync(interpreter, [...(interpreter === executable ? [] : [executable]), ...childArgs], { cwd: found.project, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
if (process.argv[1] && [resolve(process.argv[1]), canonical(process.argv[1])].some(path => import.meta.url === pathToFileURL(path).href)) {
  try { main(); } catch (error) { console.error(`[paul-loop] ${error.message}`); process.exitCode = 1; }
}
