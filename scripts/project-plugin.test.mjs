import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, realpathSync, existsSync, symlinkSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const launcher = resolve('scripts/project-plugin.mjs');
const json = value => JSON.stringify(value, null, 2) + '\n';
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'paul-project-한 글-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project'), home = join(root, 'host'), cli = join(root, 'bin');
  for (const dir of [join(project, '.codex'), home, cli]) mkdirSync(dir, { recursive: true });
  const plugins = { 'loop-engine': { id: 'loop-engine@fixture', version: '0.15.0' }, 'ship-flow': { id: 'ship-flow@fixture', version: '0.11.0' } };
  const lock = { schemaVersion: 1, runtime: 'codex', plugins };
  writeFileSync(join(project, '.codex/paul-loop.lock.json'), json(lock));
  for (const [name, info] of Object.entries(plugins)) {
    const base = join(home, 'plugins/cache/fixture', name, info.version);
    mkdirSync(join(base, '.codex-plugin'), { recursive: true });
    mkdirSync(join(base, 'bin'), { recursive: true });
    writeFileSync(join(base, '.codex-plugin/plugin.json'), json({ name, version: info.version }));
    writeFileSync(join(base, 'bin/probe.mjs'), 'console.log(JSON.stringify({argv:process.argv.slice(2),runtime:process.env.LOOP_RUNTIME,root:process.cwd()}));process.exit(7);\n');
  }
  const listing = { installed: Object.entries(plugins).map(([name, entry]) => ({ pluginId: entry.id, name, marketplaceName: 'fixture', version: entry.version, installed: true, enabled: true })), available: [] };
  writeFileSync(join(root, 'listing.json'), json(listing));
  writeFileSync(join(root, 'markets.json'), json({ marketplaces: [{ name: 'fixture', marketplaceSource: { sourceType: 'local', source: root } }] }));
  writeFileSync(join(cli, 'codex'), `#!/usr/bin/env node
const fs=require('node:fs'), path=require('node:path'), args=process.argv.slice(2);
fs.appendFileSync(process.env.CLI_TRACE,JSON.stringify(args)+'\\n');
if(args[0]==='--version') { process.stdout.write('codex-cli 0.146.0\\n'); }
else if(args[1]==='marketplace') { process.stdout.write(fs.readFileSync(process.env.CLI_MARKETS)); }
else if(args[1]==='add') {
 const file=process.env.CLI_LIST, record=JSON.parse(fs.readFileSync(file));
 const item=record.installed.find(p=>p.pluginId===args[2]);
 const next=file+'.next';
 if(fs.existsSync(next)) item.version=JSON.parse(fs.readFileSync(next))[item.name];
 fs.writeFileSync(file,JSON.stringify(record));
} else process.stdout.write(fs.readFileSync(process.env.CLI_LIST));
`, { mode: 0o755 });
  const env = { ...process.env, CODEX_HOME: home, CLI_TRACE: join(root, 'trace'), CLI_LIST: join(root, 'listing.json'), CLI_MARKETS: join(root, 'markets.json'), PATH: cli + ':' + process.env.PATH };
  const run = (...args) => spawnSync(process.execPath, [launcher, '--project', project, ...args], { env, encoding: 'utf8' });
  return { root, project, home, lock, run, listing, env };
}

test('doctor resolves an exact installed identity in a relocated home without writing project files', t => {
  const f = fixture(t);
  const before = readFileSync(join(f.project, '.codex/paul-loop.lock.json'), 'utf8');
  const result = f.run('doctor');
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.plugins['loop-engine'].version, '0.15.0');
  assert.equal(report.plugins['loop-engine'].path, join(f.home, 'plugins/cache/fixture/loop-engine/0.15.0'));
  assert.equal(readFileSync(join(f.project, '.codex/paul-loop.lock.json'), 'utf8'), before);
});

for (const failure of ['ENOTDIR', 'ELOOP', 'EACCES']) {
  test(`lock discovery rejects ${failure} before host calls or project writes`, t => {
    if (failure === 'EACCES' && process.getuid?.() === 0) {
      t.skip('root bypasses the fixture directory permissions');
      return;
    }
    const f = fixture(t), other = join(f.project, '.claude');
    const lockPath = join(f.project, '.codex/paul-loop.lock.json');
    const before = readFileSync(lockPath);
    if (failure === 'ENOTDIR') writeFileSync(other, 'not a configuration directory');
    if (failure === 'ELOOP') symlinkSync('.claude', other);
    if (failure === 'EACCES') { mkdirSync(other); chmodSync(other, 0); }
    try {
      for (const args of [['doctor'], ['sync'], ['exec', 'bin/probe.mjs'], ['update']]) {
        const result = f.run(...args);
        assert.equal(result.status, 1, `${args[0]} must reject ${failure}: ${result.stderr}`);
        assert.match(result.stderr, new RegExp(failure));
        assert.equal(result.stdout, '');
        assert.equal(existsSync(join(f.root, 'trace')), false, 'no native CLI call is permitted');
        assert.deepEqual(readFileSync(lockPath), before);
        assert.equal(existsSync(join(f.project, '.codex/paul-loop.plugins.json')), false);
        assert.equal(existsSync(join(f.project, '.loop')), false);
      }
    } finally {
      if (failure === 'EACCES') chmodSync(other, 0o700);
    }
  });
}

test('exec forwards literal argv and child exit code without a shell or project writes', t => {
  const f = fixture(t);
  const result = f.run('exec', 'bin/probe.mjs', 'space name', '$(touch nope)', '--project', 'child-value');
  assert.equal(result.status, 7, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { argv: ['space name', '$(touch nope)', '--project', 'child-value'], runtime: 'codex', root: f.project });
});

test('rejects mismatched native registration, duplicate identity, and cache manifest before execution', t => {
  const f = fixture(t), listing = join(f.root, 'listing.json');
  f.listing.installed[0].version = '0.14.0'; writeFileSync(listing, json(f.listing));
  const rejected = f.run('exec', 'bin/probe.mjs');
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /installed version differs/);
  assert.equal(rejected.stdout, '');
  f.listing.installed[0].version = '0.15.0'; f.listing.installed.push({ ...f.listing.installed[0] }); writeFileSync(listing, json(f.listing));
  assert.match(f.run('doctor').stderr, /ambiguous/);
  f.listing.installed.pop(); writeFileSync(listing, json(f.listing));
  writeFileSync(join(f.home, 'plugins/cache/fixture/loop-engine/0.15.0/.codex-plugin/plugin.json'), json({ name: 'unrelated', version: '0.15.0' }));
  assert.match(f.run('doctor').stderr, /identity drift/);
});

test('sync writes only a generated registry, preserves other settings, and refuses conflicting registry/symlink', t => {
  const f = fixture(t), registry = join(f.project, '.codex/paul-loop.plugins.json');
  const config = join(f.project, '.codex/ship-flow.config.json');
  writeFileSync(config, '{"verifyCommand":"private-root-verifier","custom":17}\n');
  const before = readFileSync(config, 'utf8');
  assert.equal(f.run('sync').status, 0);
  assert.equal(readFileSync(config, 'utf8'), before);
  const installed = JSON.parse(readFileSync(registry));
  assert.equal(installed.runtime, 'codex');
  assert.equal(installed.plugins['loop-engine'].path, join(f.home, 'plugins/cache/fixture/loop-engine/0.15.0'));
  assert.equal(f.run('sync').status, 0);
  installed.plugins['loop-engine'].path = '/someone/else'; writeFileSync(registry, json(installed));
  assert.match(f.run('sync').stderr, /conflict/);
  assert.equal(JSON.parse(readFileSync(registry)).plugins['loop-engine'].path, '/someone/else');
  rmSync(registry); symlinkSync(config, registry);
  assert.match(f.run('sync').stderr, /symlink/);
  assert.equal(readFileSync(config, 'utf8'), before);
});

test('vendored doctor/exec requires no host CLI, and updater refuses vendored ownership', t => {
  const f = fixture(t);
  const lockPath = join(f.project, '.codex/paul-loop.lock.json');
  for (const name of Object.keys(f.lock.plugins)) {
    const base = join(f.project, 'plugins', name);
    mkdirSync(join(base, '.codex-plugin'), { recursive: true });
    writeFileSync(join(base, '.codex-plugin/plugin.json'), json({ name, version: f.lock.plugins[name].version }));
    f.lock.plugins[name] = { path: `../plugins/${name}`, version: f.lock.plugins[name].version };
  }
  writeFileSync(lockPath, json(f.lock));
  assert.equal(f.run('doctor').status, 0);
  assert.match(f.run('update').stderr, /vendored/);
  assert.equal(existsSync(join(f.root, 'trace')), false);
});

test('update reuses a local marketplace without Git upgrade and advances only verified project versions', t => {
  const f = fixture(t);
  assert.equal(f.run('sync').status, 0);
  const next = { 'loop-engine': '0.15.1', 'ship-flow': '0.11.1' };
  for (const [name, version] of Object.entries(next)) {
    const base = join(f.home, 'plugins/cache/fixture', name, version);
    mkdirSync(join(base, '.codex-plugin'), { recursive: true });
    writeFileSync(join(base, '.codex-plugin/plugin.json'), json({ name, version }));
  }
  writeFileSync(join(f.root, 'listing.json.next'), json(next));
  const result = f.run('update');
  assert.equal(result.status, 0, result.stderr);
  const lock = JSON.parse(readFileSync(join(f.project, '.codex/paul-loop.lock.json')));
  assert.equal(lock.plugins['loop-engine'].version, '0.15.1');
  assert.equal(lock.plugins['loop-engine'].id, 'loop-engine@fixture');
  assert.equal(JSON.parse(readFileSync(join(f.project, '.codex/paul-loop.plugins.json'))).plugins['ship-flow'].version, '0.11.1');
  const trace = readFileSync(join(f.root, 'trace'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(trace.filter(args => args[1] === 'add'), [['plugin', 'add', 'loop-engine@fixture'], ['plugin', 'add', 'ship-flow@fixture']]);
  assert.equal(trace.some(args => args.includes('upgrade')), false);
});

test('disabled installs and registry conflicts reject update before any host mutation', t => {
  const f = fixture(t);
  f.listing.installed[1].enabled = false; writeFileSync(join(f.root, 'listing.json'), json(f.listing));
  assert.match(f.run('update').stderr, /disabled/);
  f.listing.installed[1].enabled = true; writeFileSync(join(f.root, 'listing.json'), json(f.listing));
  writeFileSync(join(f.project, '.codex/paul-loop.plugins.json'), json({ schemaVersion: 1, runtime: 'codex', plugins: { 'loop-engine': { path: '/foreign', version: '0.15.0' } } }));
  assert.match(f.run('update').stderr, /conflict/);
  const trace = readFileSync(join(f.root, 'trace'), 'utf8');
  assert.equal(trace.includes('"add"'), false);
  assert.equal(trace.includes('"upgrade"'), false);
});

test('Git marketplace refresh is explicit and failed cache validation retains the old lock', t => {
  const f = fixture(t), lock = join(f.project, '.codex/paul-loop.lock.json');
  writeFileSync(join(f.root, 'markets.json'), json({ marketplaces: [{ name: 'fixture', marketplaceSource: { sourceType: 'git' } }] }));
  const before = readFileSync(lock, 'utf8');
  writeFileSync(join(f.root, 'listing.json.next'), json({ 'loop-engine': '0.15.1', 'ship-flow': '0.11.1' }));
  const result = f.run('update');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /host updates applied.*incomplete/);
  assert.equal(readFileSync(lock, 'utf8'), before);
  const trace = readFileSync(join(f.root, 'trace'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(trace.filter(args => args[2] === 'upgrade'), [['plugin', 'marketplace', 'upgrade', 'fixture']]);
  assert.equal(existsSync(join(f.project, '.codex/paul-loop.plugins.json')), false);
});

test('exec rejects traversal and a bin-directory symlink outside the selected plugin', t => {
  const f = fixture(t), base = join(f.home, 'plugins/cache/fixture/loop-engine/0.15.0');
  assert.notEqual(f.run('exec', 'bin/../.codex-plugin/plugin.json').status, 0);
  const outside = join(f.root, 'outside-bin'); mkdirSync(outside);
  const sentinel = join(f.root, 'executed');
  writeFileSync(join(outside, 'evil.mjs'), `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(sentinel)},'bad');\n`);
  rmSync(join(base, 'bin'), { recursive: true }); symlinkSync(outside, join(base, 'bin'));
  assert.notEqual(f.run('exec', 'bin/evil.mjs').status, 0);
  assert.equal(existsSync(sentinel), false);
});

test('Claude resolves only the exact project scope and preserves disabled activation', t => {
  const f = fixture(t);
  mkdirSync(join(f.project, '.claude'));
  const lock = { ...f.lock, runtime: 'claude', plugins: { 'loop-engine': { id: 'loop-engine@fixture', version: '0.15.0', scope: 'project' } } };
  rmSync(join(f.project, '.codex/paul-loop.lock.json'));
  writeFileSync(join(f.project, '.claude/paul-loop.lock.json'), json(lock));
  const base = join(f.root, 'claude-cache'); mkdirSync(join(base, '.claude-plugin'), { recursive: true });
  writeFileSync(join(base, '.claude-plugin/plugin.json'), json({ name: 'loop-engine', version: '0.15.0' }));
  const entries = [{ id: 'loop-engine@fixture', scope: 'project', projectPath: '/nonexistent/unrelated-project', version: '0.15.0', installPath: '/wrong', enabled: true }, { id: 'loop-engine@fixture', scope: 'project', projectPath: f.project, version: '0.15.0', installPath: base, enabled: false }];
  writeFileSync(join(f.root, 'listing.json'), json(entries));
  writeFileSync(join(f.root, 'bin/claude'), '#!/usr/bin/env node\nconst fs=require("node:fs");fs.appendFileSync(process.env.CLI_TRACE,JSON.stringify(process.argv.slice(2))+"\\n");process.stdout.write(fs.readFileSync(process.env.CLI_LIST));\n', { mode: 0o755 });
  const result = f.run('update'); assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).plugins['loop-engine'].enabled, false);
  const trace = readFileSync(join(f.root, 'trace'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(trace.filter(args => args[1] === 'update'), [['plugin', 'update', 'loop-engine@fixture', '--scope', 'project']]);
});

test('concurrent lock edits stop the remaining update and are never overwritten', t => {
  const f = fixture(t), lock = join(f.project, '.codex/paul-loop.lock.json');
  const cli = join(f.root, 'bin/codex');
  writeFileSync(cli, readFileSync(cli, 'utf8') + `\nif(args[1]==='add')fs.appendFileSync(${JSON.stringify(lock)},'\\n');\n`);
  const before = readFileSync(lock, 'utf8');
  const result = f.run('update');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /concurrent file conflict/);
  assert.equal(readFileSync(lock, 'utf8'), before + '\n');
  const calls = readFileSync(join(f.root, 'trace'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(calls.filter(args => args[1] === 'add').length, 1);
});

test('sync refuses an escaping backup directory before creating anything outside the project', t => {
  const f = fixture(t), outside = join(f.root, 'outside'); mkdirSync(outside);
  symlinkSync(outside, join(f.project, '.loop'));
  assert.notEqual(f.run('sync').status, 0);
  assert.equal(existsSync(join(outside, 'plugin-updates')), false);
  assert.equal(existsSync(join(f.project, '.codex/paul-loop.plugins.json')), false);
});

test('symlink entrypoints execute normally and unqualified host versions never dispatch', t => {
  const f = fixture(t), link = join(f.root, 'launcher-link.mjs'); symlinkSync(launcher, link);
  const throughLink = spawnSync(process.execPath, [link, '--project', f.project, 'doctor'], { env: f.env, encoding: 'utf8' });
  assert.equal(throughLink.status, 0, throughLink.stderr); assert.equal(JSON.parse(throughLink.stdout).runtime, 'codex');
  const cli = join(f.root, 'bin/codex'); writeFileSync(cli, readFileSync(cli, 'utf8').replace('0.146.0', '99.0.0'));
  const result = f.run('exec', 'bin/probe.mjs'); assert.equal(result.status, 1); assert.match(result.stderr, /unsupported Codex/); assert.equal(result.stdout, '');
});

test('known write blockers stop update before any installation mutation', t => {
  const f = fixture(t), outside = join(f.root, 'outside'); mkdirSync(outside); symlinkSync(outside, join(f.project, '.loop'));
  assert.notEqual(f.run('update').status, 0);
  const trace = readFileSync(join(f.root, 'trace'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(trace.some(args => args[1] === 'add' || args[2] === 'upgrade'), false);
});

test('observed app CLI 0.153.1 resolves exact caches while unqualified releases reject execution', t => {
  const f = fixture(t), cli = join(f.root, 'bin/codex'), source = readFileSync(cli, 'utf8');
  writeFileSync(cli, source.replace('0.146.0', '0.153.1'));
  const result = f.run('exec', 'bin/probe.mjs');
  assert.equal(result.status, 7, result.stderr);
  assert.equal(JSON.parse(result.stdout).runtime, 'codex');
  writeFileSync(cli, source.replace('0.146.0', '0.153.2'));
  const rejected = f.run('exec', 'bin/probe.mjs');
  assert.equal(rejected.status, 1); assert.match(rejected.stderr, /unsupported Codex/); assert.equal(rejected.stdout, '');
});

test('a competing edit during publication is retained and cannot produce success', t => {
  const f = fixture(t), lock = join(f.project, '.codex/paul-loop.lock.json');
  const preload = join(f.root, 'race.mjs');
  writeFileSync(preload, `import fs from 'node:fs';import{syncBuiltinESMExports}from'node:module';
const original=fs.renameSync;let injected=false;
fs.renameSync=(from,to)=>{if(!injected&&from===${JSON.stringify(lock)}){injected=true;const d=JSON.parse(fs.readFileSync(from));d.userSetting='keep-me';fs.writeFileSync(from,JSON.stringify(d));}return original(from,to);};syncBuiltinESMExports();\n`);
  // Add a semantic-preserving lock metadata change via a same-version explicit update.
  const before = readFileSync(lock, 'utf8');
  writeFileSync(lock, JSON.stringify(JSON.parse(before)));
  const result = spawnSync(process.execPath, ['--import', preload, launcher, '--project', f.project, 'update'], { env: f.env, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.equal(JSON.parse(readFileSync(lock)).userSetting, 'keep-me');
  assert.match(result.stderr, /conflict|concurrent/);
});

test('rollback I/O failure is explicit and retained recovery files are reported', t => {
  const f = fixture(t), lock = join(f.project, '.codex/paul-loop.lock.json'), registry = join(f.project, '.codex/paul-loop.plugins.json');
  writeFileSync(lock, JSON.stringify(JSON.parse(readFileSync(lock))));
  const before = readFileSync(lock, 'utf8'), preload = join(f.root, 'rollback.mjs');
  writeFileSync(preload, `import fs from 'node:fs';import{syncBuiltinESMExports}from'node:module';
const link=fs.linkSync,rename=fs.renameSync;
fs.linkSync=(from,to)=>{if(to===${JSON.stringify(lock)}&&from.endsWith('.new'))throw new Error('LOCK_PUBLISH_FAILURE');return link(from,to);};
fs.renameSync=(from,to)=>{if(from===${JSON.stringify(registry)}&&to.endsWith('.rollback'))throw new Error('REGISTRY_ROLLBACK_FAILURE');return rename(from,to);};syncBuiltinESMExports();\n`);
  const result = spawnSync(process.execPath, ['--import', preload, launcher, '--project', f.project, 'update'], { env: f.env, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /LOCK_PUBLISH_FAILURE/);
  assert.match(result.stderr, /rollback=INCOMPLETE.*REGISTRY_ROLLBACK_FAILURE/);
  assert.match(result.stderr, /retained backups=/);
  assert.equal(readFileSync(lock, 'utf8'), before);
  assert.equal(existsSync(registry), true);
});


test('rollback retains a competing atomic replacement arriving at removal', t => {
  const f = fixture(t), lock = join(f.project, '.codex/paul-loop.lock.json'), registry = join(f.project, '.codex/paul-loop.plugins.json');
  assert.equal(f.run('sync').status, 0);
  const prior = readFileSync(registry, 'utf8');
  // Force both files to need publication without changing installed versions.
  writeFileSync(registry, JSON.stringify(JSON.parse(prior)));
  writeFileSync(lock, JSON.stringify(JSON.parse(readFileSync(lock))));
  const preload = join(f.root, 'rollback-race.mjs');
  writeFileSync(preload, `import fs from 'node:fs';import{syncBuiltinESMExports}from'node:module';
const link=fs.linkSync,rename=fs.renameSync,unlink=fs.unlinkSync;let rollback=false,injected=false;
const registry=${JSON.stringify(registry)},lock=${JSON.stringify(lock)};
function inject(p){if(rollback&&!injected&&p===registry){injected=true;const edit=JSON.parse(fs.readFileSync(p));edit.userSetting='competing-rollback-edit';const stage=p+'.competing';fs.writeFileSync(stage,JSON.stringify(edit));rename(stage,p);}}
fs.linkSync=(from,to)=>{if(to===lock&&from.endsWith('.new')){rollback=true;throw new Error('LOCK_PUBLISH_FAILURE');}return link(from,to);};
fs.renameSync=(from,to)=>{inject(from);return rename(from,to);};fs.unlinkSync=p=>{inject(p);return unlink(p);};syncBuiltinESMExports();\n`);
  const result = spawnSync(process.execPath, ['--import', preload, launcher, '--project', f.project, 'update'], { env: f.env, encoding: 'utf8' });
  assert.equal(result.status, 1);
  const backup = join(f.project, '.loop/plugin-updates');
  const allBytes = readdirSync(backup, { recursive: true }).map(p=>join(backup,p)).filter(p=>/\.(before|rollback)$/.test(p)).map(p=>readFileSync(p,'utf8'));
  if (existsSync(registry)) allBytes.push(readFileSync(registry,'utf8'));
  assert.ok(allBytes.some(bytes=>bytes.includes('competing-rollback-edit')), 'concurrent replacement must survive in the live path or retained recovery files');
  assert.match(result.stderr, /rollback=INCOMPLETE/);
});
