#!/usr/bin/env node
// Bounded local distribution of an already generated/reviewed build. No source execution.
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const MARKET = 'paul-loop-codex';
const REPOSITORY = 'https://github.com/reach0908/paul-loop';
const CORE = ['loop-engine', 'ship-flow'];
const PLUGINS = [...CORE, 'loop-memory'];
const MARKER = '.paul-loop-generated.json';
const RECEIPT = '.paul-loop-install.json';
const CATALOG = '.agents/plugins/marketplace.json';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fail = message => { throw new Error(message); };
const stat = path => { try { return lstatSync(path); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
const parse = (bytes, label) => { try { return JSON.parse(bytes.toString('utf8')); } catch { fail(`Invalid JSON: ${label}. Regenerate the reviewed provider build.`); } };
const inside = (root, path) => { const rel = relative(root, path); return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)); };

function safeRelative(path) {
  if (typeof path !== 'string' || !path || /[\\:\x00-\x1f\x7f]/.test(path) || isAbsolute(path)
      || path.split('/').some(p => !p || p === '.' || p === '..')) fail(`Unsafe inventory path: ${JSON.stringify(path)}`);
}

// Check every ancestor, including dangling links. Use physical paths on systems with /tmp aliases.
function safeAbsolute(input) {
  if (typeof input !== 'string' || !input || /[\x00-\x1f\x7f]/.test(input)
      || input.split(/[\\/]/).includes('..')) fail('Use a local path without traversal or control characters.');
  const path = resolve(input);
  let current = path;
  while (true) {
    const info = stat(current);
    if (info?.isSymbolicLink()) fail(`Symlink rejected: ${current}. Supply the physical directory path.`);
    if (info && !info.isDirectory()) fail(`Expected a directory: ${current}`);
    if (dirname(current) === current) break;
    current = dirname(current);
  }
  return path;
}

function inventory(value, label, optionalMode = false) {
  if (!object(value) || !Object.keys(value).length) fail(`Missing inventory: ${label}`);
  for (const [path, item] of Object.entries(value)) {
    safeRelative(path);
    if (!object(item) || !/^[a-f0-9]{64}$/.test(item.sha256 || '')
        || (!(optionalMode && item.mode === undefined) && (!Number.isInteger(item.mode) || item.mode < 0 || item.mode > 0o777))) {
      fail(`Invalid hash/mode inventory entry: ${label}/${path}`);
    }
  }
  return value;
}

function readRegular(root, rel) {
  safeRelative(rel);
  let parent = root;
  for (const part of rel.split('/').slice(0, -1)) {
    parent = join(parent, part);
    if (!stat(parent)?.isDirectory()) fail(`Missing or unsafe parent directory: ${parent}`);
  }
  const path = join(root, rel), info = stat(path);
  if (!info?.isFile() || (info.mode & 0o7000)) fail(`Missing or unsafe regular file: ${path}`);
  return { bytes: readFileSync(path), mode: info.mode & 0o777 };
}

function directories(paths) {
  const result = new Set();
  for (const path of paths) {
    let dir = dirname(path);
    while (dir !== '.') { result.add(dir); dir = dirname(dir); }
  }
  return result;
}

// Exact file and directory sets: unlisted files and even empty directories are preserved by refusal.
function verifyTree(root, expected, extras = [], installed = false) {
  const allowed = new Set([...Object.keys(expected), ...extras]);
  const dirs = directories(allowed), seen = new Set();
  const walk = (dir, prefix = '') => {
    const info = stat(dir);
    if (!info?.isDirectory() || (info.mode & 0o7000) || (installed && (info.mode & 0o777) !== 0o755)) fail(`Unsafe or edited directory: ${dir}`);
    for (const name of readdirSync(dir)) {
      const rel = prefix ? `${prefix}/${name}` : name;
      safeRelative(rel);
      const path = join(root, rel), entry = stat(path);
      if (entry?.isDirectory()) {
        if (!dirs.has(rel)) fail(`Unexpected directory: ${path}. Preserve it elsewhere before retrying.`);
        walk(path, rel);
      } else {
        if (!allowed.has(rel)) fail(`Unexpected file: ${path}. Preserve it elsewhere before retrying.`);
        const { bytes, mode } = readRegular(root, rel), wanted = expected[rel];
        if (wanted && (wanted.sha256 !== sha(bytes) || wanted.mode !== mode)) fail(`Hash/mode mismatch: ${path}. Preserve local edits or regenerate the reviewed build.`);
        seen.add(rel);
      }
    }
  };
  walk(root);
  for (const path of allowed) if (!seen.has(path)) fail(`Missing file: ${join(root, path)}. Regenerate or restore the previous intact installation.`);
}

function readMarker(bytes) {
  const marker = parse(bytes, MARKER);
  if (marker.schemaVersion !== 1 || marker.adapterVersion !== '1.0.0') fail('Unsupported generated inventory schema/adapter; use a compatible reviewed installer.');
  inventory(marker.files, MARKER);
  for (const path of Object.keys(marker.files)) {
    if (path !== 'provenance.json' && !path.startsWith('codex/') && !path.startsWith('claude/')) fail(`Unexpected generated inventory namespace: ${path}`);
  }
  if (!marker.files['provenance.json'] || !marker.files[`codex/${CATALOG}`]) fail('Generated provenance or Codex catalog is missing from the inventory.');
  return marker;
}

function validateMetadata(marker, read) {
  const provenance = parse(read('provenance.json'), 'provenance.json');
  if (provenance.schemaVersion !== 1 || provenance.adapterVersion !== marker.adapterVersion
      || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(provenance.sourceCommit || '')
      || !object(provenance.sourceVersions)
      || !equal(Object.keys(provenance.sourceVersions).sort(), [...PLUGINS].sort())) fail('Invalid source provenance/version identity. Regenerate the reviewed provider.');
  inventory(provenance.sourceHashes, 'sourceHashes', true);
  for (const path of ['scripts/generate-runtime-packages.mjs', '.claude-plugin/marketplace.json']) {
    if (!provenance.sourceHashes[path]) fail(`Missing source provenance: ${path}`);
  }
  const catalog = parse(read(CATALOG), CATALOG);
  if (catalog.name !== MARKET || !Array.isArray(catalog.plugins) || catalog.plugins.length !== PLUGINS.length
      || !equal(catalog.plugins.map(p => p.name).sort(), [...PLUGINS].sort())) fail(`Expected the generated ${MARKET} catalog with its three source plugins.`);
  for (const entry of catalog.plugins) {
    const name = entry.name, version = provenance.sourceVersions[name];
    if (entry.source?.source !== 'local' || entry.source.path !== `./plugins/${name}`
        || entry.policy?.installation !== 'AVAILABLE' || entry.policy?.authentication !== 'ON_INSTALL') fail(`Unsafe catalog source/policy: ${name}`);
    if (typeof version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) fail(`Invalid source version: ${name}`);
    const manifestPath = `plugins/${name}/.codex-plugin/plugin.json`;
    if (!marker.files[`codex/${manifestPath}`] || !provenance.sourceHashes[`tools/${name}/.claude-plugin/plugin.json`]) fail(`Missing plugin manifest inventory/provenance: ${name}`);
    const manifest = parse(read(manifestPath), manifestPath);
    if (manifest.name !== name || manifest.version !== version || manifest.repository !== REPOSITORY) fail(`Plugin name/version/source identity mismatch: ${name}`);
  }
  return provenance;
}

function projection(marker, markerBytes, markerMode) {
  const files = Object.fromEntries(Object.entries(marker.files).filter(([p]) => p.startsWith('codex/')).map(([p, data]) => [p.slice(6), data]));
  if ([MARKER, RECEIPT, 'provenance.json'].some(path => files[path])) fail('Generated payload conflicts with installer metadata/ownership receipt.');
  files['provenance.json'] = marker.files['provenance.json'];
  files[MARKER] = { sha256: sha(markerBytes), mode: markerMode };
  return files;
}

function inspectBuild(build) {
  const { bytes, mode } = readRegular(build, MARKER), marker = readMarker(bytes);
  if (mode !== 0o644) fail('Generated inventory marker must have mode 0644.');
  verifyTree(build, marker.files, [MARKER]);
  const provenance = validateMetadata(marker, rel => readRegular(build, rel === 'provenance.json' ? rel : `codex/${rel}`).bytes);
  return { marker, markerBytes: bytes, provenance, files: projection(marker, bytes, mode) };
}

function inspectTarget(target) {
  if (!stat(target)) return null;
  const receiptPath = join(target, RECEIPT);
  if (!stat(receiptPath)?.isFile()) fail(`Refusing unowned directory: ${target}. Choose a new dedicated directory; do not add a receipt to adopt existing files.`);
  const { bytes, mode } = readRegular(target, RECEIPT), receipt = parse(bytes, RECEIPT);
  if (mode !== 0o644 || receipt.schemaVersion !== 1 || receipt.kind !== 'paul-loop-codex-local-install'
      || receipt.marketplace !== MARKET || receipt.sourceIdentity !== REPOSITORY || receipt.targetRoot !== target) fail(`Ownership/source/root identity mismatch: ${target}. Restore the recorded root or select an unused destination; no automatic migration.`);
  inventory(receipt.files, RECEIPT);
  verifyTree(target, receipt.files, [RECEIPT], true);
  const stored = readRegular(target, MARKER), marker = readMarker(stored.bytes);
  if (!equal(receipt.files, projection(marker, stored.bytes, stored.mode))) fail(`Installed inventory/receipt mismatch: ${target}`);
  const provenance = validateMetadata(marker, rel => readRegular(target, rel).bytes);
  if (receipt.sourceCommit !== provenance.sourceCommit || !equal(receipt.sourceVersions, provenance.sourceVersions)) fail(`Installed provenance/receipt mismatch: ${target}`);
  return { receipt, receiptHash: sha(bytes) };
}

function cli(args, completed) {
  let stdout;
  try {
    stdout = execFileSync('codex', args, { encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    fail(`codex ${args.join(' ')} failed (${error.code || error.status || error.signal || 'unknown'}). ${String(error.stderr || '').trim()} Check CLI availability/state and rerun the same installer; no config or trust override was attempted.`);
  }
  completed.push(['codex', ...args]);
  return parse(stdout, `codex ${args.join(' ')}`);
}

function registration(target, completed, required = false) {
  const result = cli(['plugin', 'marketplace', 'list', '--json'], completed);
  if (!Array.isArray(result.marketplaces) || result.marketplaces.some(m => !object(m) || typeof m.name !== 'string' || typeof m.root !== 'string')) fail('Unsupported Codex marketplace list response; use a compatible official CLI.');
  const samePath = value => typeof value === 'string' && isAbsolute(value) && resolve(value) === target;
  const relevant = result.marketplaces.filter(m => m.name === MARKET || samePath(m.root) || samePath(m.marketplaceSource?.source));
  if (!relevant.length && !required) return false;
  if (relevant.length !== 1 || relevant[0].name !== MARKET || relevant[0].root !== target
      || relevant[0].marketplaceSource?.sourceType !== 'local' || relevant[0].marketplaceSource.source !== target) {
    fail(`Marketplace identity conflict: ${MARKET} must have LOCAL source and root exactly ${target}. Inspect codex plugin marketplace list --json and explicitly resolve the conflicting registration; this installer will not replace or rename it.`);
  }
  return true;
}

function activationState(target, completed, expectedVersions = null) {
  const result = cli(['plugin', 'list', '--json'], completed);
  if (!object(result) || !Array.isArray(result.installed)
      || result.installed.some(p => !object(p) || typeof p.pluginId !== 'string')) fail('Unsupported Codex plugin list response; existing activation is unknown. Inspect codex plugin list --json before retrying.');
  return Object.fromEntries(CORE.map(name => {
    const id = `${name}@${MARKET}`;
    const matches = result.installed.filter(p => p.pluginId === id || (p.name === name && p.marketplaceName === MARKET));
    if (!matches.length && !expectedVersions) return [name, { installed: false, enabled: null }];
    const entry = matches[0];
    if (matches.length !== 1 || entry.pluginId !== id || entry.name !== name || entry.marketplaceName !== MARKET
        || entry.installed !== true || typeof entry.version !== 'string' || !entry.version
        || entry.marketplaceSource?.sourceType !== 'local' || entry.marketplaceSource.source !== target) fail(`Unknown or ambiguous installed core identity/state: ${id}. Inspect codex plugin list --json; no activation/config override will be attempted.`);
    if (entry.enabled !== true) fail(`${expectedVersions ? 'Post-install' : 'Existing'} core activation is ${entry.enabled === false ? 'disabled' : 'unknown'}: ${id}. Preserve this setting and stop; resolve the intended activation separately before retrying. This installer never re-enables an existing disabled core.`);
    if (expectedVersions && entry.version !== expectedVersions[name]) fail(`Post-install version differs from the reviewed build: ${id}. Inspect codex plugin list --json before retrying.`);
    return [name, { installed: true, enabled: true, version: entry.version }];
  }));
}

function unchangedTarget(target, previous) {
  safeAbsolute(target);
  const current = inspectTarget(target);
  if ((current?.receiptHash ?? null) !== (previous?.receiptHash ?? null)) fail('Destination changed during preparation. Inspect it and retry.');
}

export function install({ build: buildInput, marketplaceDir, apply = false }) {
  const build = safeAbsolute(buildInput), target = safeAbsolute(marketplaceDir);
  if (!stat(build)) fail(`Generated build does not exist: ${build}`);
  if (!stat(dirname(target))) fail(`Destination parent must already exist: ${dirname(target)}. Create a durable local parent explicitly, then retry.`);
  if (inside(build, target) || inside(target, build)) fail('Build and marketplace directories must be separate, non-overlapping trees.');
  const lock = `${target}.paul-loop-install.lock`;
  if (stat(lock)) fail(`Installer lock exists: ${lock}. Wait for the active installer; after an interrupted run, inspect its staging/backup directories before removing this lock manually.`);
  const source = inspectBuild(build), previous = inspectTarget(target);
  const changes = !previous || !equal(previous.receipt.files, source.files);
  const plan = {
    mode: apply ? 'apply' : 'plan', build, marketplaceDir: target, marketplace: MARKET,
    sourceCommit: source.provenance.sourceCommit, versions: Object.fromEntries(CORE.map(name => [name, source.provenance.sourceVersions[name]])),
    publication: changes ? (previous ? 'update-with-backup' : 'create') : 'already-current',
    registration: 'unchecked until apply; requires matching LOCAL source and root',
    activation: 'unchecked until apply; existing core must be verifiably enabled before publication',
    commands: [
      ['codex', 'plugin', 'marketplace', 'list', '--json'],
      ['codex', 'plugin', 'list', '--json'],
      ['codex', 'plugin', 'marketplace', 'add', target, '--json'],
      ['codex', 'plugin', 'marketplace', 'list', '--json'],
      ...CORE.map(name => ['codex', 'plugin', 'add', `${name}@${MARKET}`, '--json']),
      ['codex', 'plugin', 'list', '--json'],
    ],
    commandNote: 'marketplace add runs only when unregistered; --apply is required for all CLI commands',
  };
  if (!apply) return plan;

  // Exclusive sibling lock coordinates this installer only; external writers must be quiescent.
  mkdirSync(lock, { mode: 0o700 });
  let stage, stageInventory, backup = null, published = false;
  const completed = [];
  try {
    unchangedTarget(target, previous);
    if (changes) {
      stage = mkdtempSync(`${target}.stage-`);
      chmodSync(stage, 0o755);
      for (const [rel, wanted] of Object.entries(source.files)) {
        const from = rel === MARKER || rel === 'provenance.json' ? rel : `codex/${rel}`;
        const { bytes, mode } = readRegular(build, from);
        if (sha(bytes) !== wanted.sha256 || mode !== wanted.mode) fail(`Build changed during preparation: ${from}. Regenerate/review and retry.`);
        const to = join(stage, rel);
        mkdirSync(dirname(to), { recursive: true });
        writeFileSync(to, bytes, { flag: 'wx', mode });
        chmodSync(to, mode);
      }
      for (const dir of directories(Object.keys(source.files))) chmodSync(join(stage, dir), 0o755);
      const receipt = { schemaVersion: 1, kind: 'paul-loop-codex-local-install', marketplace: MARKET,
        sourceIdentity: REPOSITORY, targetRoot: target, sourceCommit: source.provenance.sourceCommit,
        sourceVersions: source.provenance.sourceVersions, files: source.files };
      const receiptBytes = json(receipt);
      writeFileSync(join(stage, RECEIPT), receiptBytes, { flag: 'wx', mode: 0o644 });
      chmodSync(join(stage, RECEIPT), 0o644);
      stageInventory = { ...source.files, [RECEIPT]: { sha256: sha(receiptBytes), mode: 0o644 } };
      verifyTree(stage, stageInventory, [], true);
    }
    // All payload preparation precedes CLI calls. Conflicts stop before destination publication.
    const registered = registration(target, completed);
    if (registered && !previous) fail('Registered marketplace root has no owned installation. Restore the intact owned directory or resolve the registration explicitly before retrying.');
    // Also inspect clean installs: a missing marketplace registration must not hide a disabled cache.
    const beforeActivation = activationState(target, completed);
    unchangedTarget(target, previous);
    if (changes) {
      // Preflight is an external process: recheck staging after it, before moving the old root.
      verifyTree(stage, stageInventory, [], true);
      if (previous) {
        const candidate = `${target}.backup-${randomUUID()}`;
        renameSync(target, candidate);
        backup = candidate;
        try {
          // Detect edits that happened between validation and the first rename; retain them.
          verifyTree(backup, previous.receipt.files, [RECEIPT], true);
          if (sha(readRegular(backup, RECEIPT).bytes) !== previous.receiptHash) fail('Receipt changed during publication.');
        } catch (error) { renameSync(backup, target); backup = null; throw error; }
      }
      try { renameSync(stage, target); stage = undefined; published = true; }
      catch (error) {
        if (backup && !stat(target)) { renameSync(backup, target); backup = null; }
        throw error;
      }
    }
    inspectTarget(target);
    if (!registered) {
      const added = cli(['plugin', 'marketplace', 'add', target, '--json'], completed);
      if (added.marketplaceName !== MARKET || added.installedRoot !== target) fail('CLI registered an unexpected marketplace identity/root. Inspect CLI state before retrying.');
    }
    registration(target, completed, true);
    const installedCaches = [];
    for (const name of CORE) {
      const added = cli(['plugin', 'add', `${name}@${MARKET}`, '--json'], completed);
      if (added.pluginId !== `${name}@${MARKET}` || added.name !== name || added.marketplaceName !== MARKET
          || added.version !== plan.versions[name] || typeof added.installedPath !== 'string' || !isAbsolute(added.installedPath)) fail(`CLI install identity/version response mismatch: ${name}. Inspect installed state before retrying.`);
      const prefix = `plugins/${name}/`;
      const expected = Object.fromEntries(Object.entries(source.files).filter(([path]) => path.startsWith(prefix)).map(([path, data]) => [path.slice(prefix.length), data]));
      const path = safeAbsolute(added.installedPath);
      verifyTree(path, expected);
      installedCaches.push({ path, expected });
    }
    const afterActivation = activationState(target, completed, plan.versions);
    // A later CLI action can refresh an earlier plugin. Bind success to both caches
    // after all CLI mutations and observations have finished, not only their add responses.
    for (const { path, expected } of installedCaches) verifyTree(safeAbsolute(path), expected);
    return { ...plan, registration: 'verified LOCAL source/root', status: 'installed', backup, completed,
      activation: { before: beforeActivation, after: afterActivation, existingEnabledStatesPreserved: true },
      nativeActivation: 'not-verified; start a new Codex task; hook trust is unchanged' };
  } catch (error) {
    const publicationState = published ? 'published; retained for inspection/retry'
      : backup ? 'interrupted; inspect target and restore the retained backup if absent' : 'not changed';
    fail(`${error.message}\nCompleted CLI commands: ${JSON.stringify(completed)}\nMarketplace publication: ${publicationState}; backup: ${backup || 'none'}. CLI effects are not rolled back automatically.`);
  } finally {
    if (stage) rmSync(stage, { recursive: true, force: true });
    rmSync(lock, { recursive: true });
  }
}

function main() {
  const args = process.argv.slice(2), options = {}, seen = new Set();
  const usage = 'Usage: node scripts/install-codex.mjs --build DIR --marketplace-dir DIR [--plan | --apply]';
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) { console.log(usage); return; }
  while (args.length) {
    const flag = args.shift();
    if (seen.has(flag)) fail(`Duplicate option: ${flag}. ${usage}`);
    seen.add(flag);
    if (flag === '--apply' || flag === '--plan') continue;
    if (!['--build', '--marketplace-dir'].includes(flag)) fail(`Unknown option: ${flag}. ${usage}`);
    const value = args.shift();
    if (!value || value.startsWith('--')) fail(`Missing value for ${flag}. ${usage}`);
    options[flag === '--build' ? 'build' : 'marketplaceDir'] = value;
  }
  if (!options.build || !options.marketplaceDir || (seen.has('--apply') && seen.has('--plan'))) fail(usage);
  console.log(JSON.stringify(install({ ...options, apply: seen.has('--apply') }), null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(); } catch (error) { console.error(`[paul-loop install-codex] ${error.message}`); process.exitCode = 1; }
}
