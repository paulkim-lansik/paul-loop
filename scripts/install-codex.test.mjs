import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPackages, writePackages } from './generate-runtime-packages.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const installer = join(root, 'scripts/install-codex.mjs');
const marker = '.paul-loop-generated.json', receipt = '.paul-loop-install.json';
const catalog = 'codex/.agents/plugins/marketplace.json';
const manifest = 'codex/plugins/ship-flow/.codex-plugin/plugin.json';
const payload = 'codex/plugins/loop-engine/bin/verdict-run.sh';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
const generated = buildPackages(root);

// An executable fake at the real PATH/CLI seam, using the official 0.146.0 JSON shapes.
// It never reads the user's home/configuration and fails on any unapproved command.
const fake = String.raw`
import {appendFileSync,cpSync,existsSync,mkdirSync,readFileSync,readdirSync,rmSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
const args=process.argv.slice(2), home=process.env.CODEX_HOME, target=process.env.FAKE_TARGET;
const statePath=join(home,'fake-state.json'), log=join(home,'calls.jsonl');
const read=p=>JSON.parse(readFileSync(p,'utf8'));
const state=existsSync(statePath)?read(statePath):{marketplaces:[],installed:[]};
const stages=readdirSync(dirname(target)).filter(n=>n.startsWith(target.split('/').at(-1)+'.stage-'));
appendFileSync(log,JSON.stringify({args,prepared:existsSync(join(target,'.paul-loop-install.json'))||stages.some(n=>existsSync(join(dirname(target),n,'.paul-loop-install.json')))})+'\n');
const output=value=>console.log(JSON.stringify(value));
const fail=message=>{console.error(message);process.exit(7);};
if(args.join(' ')==='plugin marketplace list --json'){
 if(process.env.FAKE_FAIL==='list')fail('list failed');
 if(process.env.FAKE_FAIL==='bad-list'){output({unknown:[]});process.exit(0);}
 if(process.env.FAKE_FAIL==='remove-stage')for(const stage of stages)rmSync(join(dirname(target),stage),{recursive:true});
 if(process.env.FAKE_FAIL==='edit-stage')for(const stage of stages)writeFileSync(join(dirname(target),stage,'.paul-loop-install.json'),'{}');
 if(process.env.FAKE_FAIL==='mutate-target')writeFileSync(join(target,'plugins/loop-engine/NOTICE'),'concurrent local edit');
 output({marketplaces:state.marketplaces});
}else if(args.join(' ')==='plugin list --json'){
 if(process.env.FAKE_FAIL==='plugin-list')fail('plugin list failed');
 if(process.env.FAKE_FAIL==='bad-plugin-list'){output({available:[]});process.exit(0);}
 if(process.env.FAKE_FAIL==='null-plugin-list'){output(null);process.exit(0);}
 output({installed:state.installed||[],available:[]});
}else if(args[0]==='plugin'&&args[1]==='marketplace'&&args[2]==='add'&&args[3]===target&&args[4]==='--json'&&args.length===5){
 if(process.env.FAKE_FAIL==='marketplace-add')fail('registration failed');
 if(!existsSync(join(target,'.paul-loop-install.json')))fail('publication missing');
 state.marketplaces=[{name:'paul-loop-codex',root:target,marketplaceSource:{sourceType:'local',source:target}}];
 writeFileSync(statePath,JSON.stringify(state));
 output({marketplaceName:'paul-loop-codex',installedRoot:target,alreadyAdded:false});
}else if(args[0]==='plugin'&&args[1]==='add'&&['loop-engine@paul-loop-codex','ship-flow@paul-loop-codex'].includes(args[2])&&args[3]==='--json'&&args.length===4){
 const name=args[2].split('@')[0];
 if(process.env.FAKE_FAIL===name)fail('plugin installation failed');
 const source=join(target,'plugins',name), manifest=read(join(source,'.codex-plugin/plugin.json'));
 const installedPath=join(home,'plugins/cache/paul-loop-codex',name,manifest.version);
 rmSync(installedPath,{recursive:true,force:true});mkdirSync(dirname(installedPath),{recursive:true});
 cpSync(source,installedPath,{recursive:true});
 if(process.env.FAKE_FAIL==='cache')writeFileSync(join(installedPath,'NOTICE'),'stale cache');
 const entry={pluginId:args[2],name,marketplaceName:'paul-loop-codex',version:manifest.version,installed:true,enabled:true,
   source:{source:'local',path:source},marketplaceSource:{sourceType:'local',source:target}};
 if(name==='ship-flow'){
  if(process.env.FAKE_FAIL==='post-cache')writeFileSync(join(home,'plugins/cache/paul-loop-codex/loop-engine/0.15.0/NOTICE'),'changed by later installation');
  if(process.env.FAKE_FAIL==='post-disabled')entry.enabled=false;
  if(process.env.FAKE_FAIL==='post-unknown')delete entry.enabled;
  if(process.env.FAKE_FAIL==='post-version')entry.version='9.9.9';
 }
 state.installed=(state.installed||[]).filter(p=>p.pluginId!==entry.pluginId);
 if(!(name==='ship-flow'&&process.env.FAKE_FAIL==='post-missing'))state.installed.push(entry);
 writeFileSync(statePath,JSON.stringify(state));
 output({pluginId:args[2],name,marketplaceName:'paul-loop-codex',version:process.env.FAKE_FAIL==='version'?'9.9.9':manifest.version,installedPath,authPolicy:'ON_INSTALL'});
}else fail('unexpected command: '+JSON.stringify(args));
`;

function fixture(t, useReal = false) {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), 'paul-loop installer 한글 ')));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const build = join(temp, 'generated'), target = join(temp, 'durable marketplace');
  const home = join(temp, 'home'), bin = join(temp, 'bin');
  mkdirSync(home); mkdirSync(bin);
  writePackages(generated, build);
  writeFileSync(join(bin, 'codex'), `#!${process.execPath}\n${fake}`);
  chmodSync(join(bin, 'codex'), 0o755);
  const env = { PATH: useReal ? process.env.PATH : `${bin}:${process.env.PATH}`, HOME: home, CODEX_HOME: home, FAKE_TARGET: target };
  const invoke = (args = [], extraEnv = {}, buildPath = build, targetPath = target) => spawnSync(process.execPath,
    [installer, '--build', buildPath, '--marketplace-dir', targetPath, ...args],
    { cwd: temp, env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 30000 });
  const calls = () => existsSync(join(home, 'calls.jsonl')) ? readFileSync(join(home, 'calls.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  const setMarkets = marketplaces => {
    const path = join(home, 'fake-state.json'), state = existsSync(path) ? readJson(path) : { installed: [] };
    writeFileSync(path, json({ ...state, marketplaces }));
  };
  return { temp, build, target, home, env, invoke, calls, setMarkets };
}

function good(result) { assert.equal(result.status, 0, result.stderr || String(result.error)); return JSON.parse(result.stdout); }
function bad(result, pattern) { assert.equal(result.status, 1, result.stdout || String(result.error)); assert.match(result.stderr, pattern); }

// Contents, modes, mtimes and inode identities catch writes even if bytes are later restored.
function snapshot(root) {
  const entries = {};
  const walk = (path, rel) => {
    const info = lstatSync(path);
    entries[rel] = [info.mode, info.ino, info.mtimeMs, info.isFile() ? sha(readFileSync(path)) : null];
    if (info.isDirectory()) for (const name of readdirSync(path).sort()) walk(join(path, name), rel ? `${rel}/${name}` : name);
  };
  walk(root, '');
  return entries;
}

function updateJson(build, rel, change, rehash = true) {
  const file = join(build, rel), value = readJson(file);
  change(value); writeFileSync(file, json(value));
  if (rehash) {
    const index = readJson(join(build, marker));
    index.files[rel].sha256 = sha(readFileSync(file));
    writeFileSync(join(build, marker), json(index));
  }
}

// Model another reviewed release without changing provider source/manifests.
function nextRelease(build) {
  updateJson(build, manifest, value => { value.version = '0.11.1'; });
  updateJson(build, 'claude/plugins/ship-flow/.claude-plugin/plugin.json', value => { value.version = '0.11.1'; });
  updateJson(build, 'provenance.json', value => {
    value.sourceVersions['ship-flow'] = '0.11.1'; value.sourceCommit = 'b'.repeat(40);
    value.sourceHashes['tools/ship-flow/.claude-plugin/plugin.json'].sha256 = sha(readFileSync(join(build, 'claude/plugins/ship-flow/.claude-plugin/plugin.json')));
  });
}

test('default and explicit plan have no filesystem, host, or subprocess effects', t => {
  const f = fixture(t), before = snapshot(f.temp);
  for (const args of [[], ['--plan']]) {
    const plan = good(f.invoke(args, { PATH: '/not-a-cli-path' }));
    assert.equal(plan.mode, 'plan'); assert.equal(plan.publication, 'create');
    assert.equal(plan.commands.filter(c => c[1] === 'plugin' && c[2] === 'add').length, 2);
  }
  assert.deepEqual(snapshot(f.temp), before); assert.deepEqual(f.calls(), []);
});

test('apply prepares first, preserves generated catalog/versions/modes and installs only core', t => {
  const f = fixture(t);
  writeFileSync(join(f.home, 'config.toml'), '# sentinel trust/config\n');
  const result = good(f.invoke(['--apply']));
  assert.equal(result.status, 'installed'); assert.equal(result.backup, null);
  assert.deepEqual(readFileSync(join(f.target, '.agents/plugins/marketplace.json')), readFileSync(join(f.build, catalog)));
  for (const [path, entry] of Object.entries(readJson(join(f.build, marker)).files).filter(([p]) => p.startsWith('codex/'))) {
    const local = join(f.target, path.slice(6));
    assert.equal(sha(readFileSync(local)), entry.sha256, path); assert.equal(lstatSync(local).mode & 0o777, entry.mode, path);
  }
  assert.ok(f.calls().every(call => call.prepared));
  assert.deepEqual(f.calls().map(c => c.args), result.commands.map(c => c.slice(1)));
  assert.equal(existsSync(join(f.home, 'plugins/cache/paul-loop-codex/loop-memory')), false);
  assert.equal(readFileSync(join(f.home, 'config.toml'), 'utf8'), '# sentinel trust/config\n');
  assert.equal(existsSync(join(f.target, 'claude')), false);
});

test('relocated generated build and relocated installer work without original checkout/build', t => {
  const f = fixture(t), moved = join(f.temp, 'moved generated'), script = join(f.temp, 'installer.mjs');
  renameSync(f.build, moved); cpSync(installer, script);
  const result = spawnSync(process.execPath, [script, '--build', moved, '--marketplace-dir', f.target, '--apply'], { cwd: f.temp, env: f.env, encoding: 'utf8', timeout: 30000 });
  good(result); assert.equal(existsSync(f.build), false);
});

const corruptions = [
  ['missing marker', f => rmSync(join(f.build, marker)), /Missing or unsafe regular file/],
  ['missing provenance', f => rmSync(join(f.build, 'provenance.json')), /Missing file/],
  ['missing file', f => rmSync(join(f.build, payload)), /Missing file/],
  ['tampered output', f => writeFileSync(join(f.build, payload), 'tampered'), /Hash\/mode mismatch/],
  ['wrong executable mode', f => chmodSync(join(f.build, payload), 0o644), /Hash\/mode mismatch/],
  ['special mode', f => chmodSync(join(f.build, payload), 0o4755), /unsafe regular file/],
  ['unlisted file', f => writeFileSync(join(f.build, 'codex/extra.txt'), 'edit'), /Unexpected file/],
  ['unlisted empty directory', f => mkdirSync(join(f.build, 'codex/extra')), /Unexpected directory/],
  ['tampered other runtime', f => writeFileSync(join(f.build, 'claude/plugins/loop-engine/NOTICE'), 'tampered'), /Hash\/mode mismatch/],
  ['file symlink', f => { rmSync(join(f.build, payload)); symlinkSync('/etc/passwd', join(f.build, payload)); }, /unsafe regular file/],
  ['directory symlink', f => { rmSync(join(f.build, 'codex/plugins/ship-flow/skills'), { recursive: true }); symlinkSync(f.home, join(f.build, 'codex/plugins/ship-flow/skills')); }, /Unexpected file/],
  ['traversal entry', f => updateJson(f.build, marker, i => { i.files['../escape'] = i.files[payload]; }, false), /Unsafe inventory path/],
  ['absolute entry', f => updateJson(f.build, marker, i => { i.files['/escape'] = i.files[payload]; }, false), /Unsafe inventory path/],
  ['backslash entry', f => updateJson(f.build, marker, i => { i.files['codex\\..\\escape'] = i.files[payload]; }, false), /Unsafe inventory path/],
  ['invalid inventory hash', f => updateJson(f.build, marker, i => { i.files[payload].sha256 = 'no'; }, false), /Invalid hash\/mode/],
  ['missing inventory mode', f => updateJson(f.build, marker, i => { delete i.files[payload].mode; }, false), /Invalid hash\/mode/],
  ['unsupported schema', f => updateJson(f.build, marker, i => { i.schemaVersion = 2; }, false), /Unsupported generated/],
  ['unsupported adapter', f => updateJson(f.build, marker, i => { i.adapterVersion = '2.0.0'; }, false), /Unsupported generated/],
  ['metadata name collision', f => {
    writeFileSync(join(f.build, 'codex/provenance.json'), '{}');
    updateJson(f.build, marker, i => { i.files['codex/provenance.json'] = { sha256: sha('{}'), mode: 0o644 }; }, false);
  }, /conflicts with installer metadata/],
  ['wrong catalog name', f => updateJson(f.build, catalog, i => { i.name = 'other-marketplace'; }), /Expected the generated/],
  ['catalog traversal', f => updateJson(f.build, catalog, i => { i.plugins[0].source.path = '../escape'; }), /Unsafe catalog source/],
  ['Git catalog source', f => updateJson(f.build, catalog, i => { i.plugins[0].source.source = 'git'; }), /Unsafe catalog source/],
  ['memory auto-install policy', f => updateJson(f.build, catalog, i => { i.plugins.find(p => p.name === 'loop-memory').policy.installation = 'INSTALLED_BY_DEFAULT'; }), /Unsafe catalog source\/policy/],
  ['wrong manifest name', f => updateJson(f.build, manifest, i => { i.name = 'other'; }), /identity mismatch/],
  ['arbitrary version suffix', f => updateJson(f.build, manifest, i => { i.version += '+local'; }), /identity mismatch/],
  ['different repository source', f => updateJson(f.build, manifest, i => { i.repository = 'https://example.invalid/fork'; }), /source identity mismatch/],
  ['provenance version drift', f => updateJson(f.build, 'provenance.json', i => { i.sourceVersions['ship-flow'] = '9.0.0'; }), /identity mismatch/],
];
for (const [name, change, pattern] of corruptions) test(`rejects ${name} before CLI or destination effects`, t => {
  const f = fixture(t); change(f);
  const before = snapshot(f.temp);
  bad(f.invoke(['--apply']), pattern);
  assert.deepEqual(snapshot(f.temp), before); assert.deepEqual(f.calls(), []);
});

test('unowned directories including empty targets cannot be adopted', t => {
  const f = fixture(t); mkdirSync(f.target);
  bad(f.invoke(['--apply']), /unowned directory/);
  writeFileSync(join(f.target, 'keep.txt'), 'local data');
  const before = snapshot(f.temp);
  bad(f.invoke(['--apply']), /unowned directory/);
  assert.deepEqual(snapshot(f.temp), before);
});

for (const where of ['target', 'build', 'parent', 'dangling']) test(`rejects ${where} symlink`, t => {
  const f = fixture(t), link = join(f.temp, 'link');
  if (where === 'target' || where === 'dangling') symlinkSync(where === 'target' ? f.home : join(f.temp, 'absent'), f.target);
  else symlinkSync(where === 'build' ? f.build : f.temp, link);
  const target = where === 'parent' ? join(link, 'market') : f.target;
  const build = where === 'build' ? link : f.build;
  const before = snapshot(f.temp);
  bad(f.invoke(['--apply'], {}, build, target), /Symlink rejected/);
  assert.deepEqual(snapshot(f.temp), before); assert.deepEqual(f.calls(), []);
});

test('overlap, missing parent, path traversal, stale lock and ambiguous options fail closed', t => {
  const f = fixture(t);
  bad(f.invoke(['--apply'], {}, f.build, join(f.build, 'market')), /non-overlapping/);
  bad(f.invoke(['--apply'], {}, f.build, join(f.temp, 'absent/market')), /parent must already exist/);
  bad(f.invoke(['--apply'], {}, f.build, `${f.temp}/../market`), /without traversal/);
  for (const args of [['--plan', '--apply'], ['--apply', '--apply'], ['--force'], ['--memory']]) bad(f.invoke(args), /Usage:/);
  mkdirSync(`${f.target}.paul-loop-install.lock`);
  bad(f.invoke(['--apply']), /Installer lock exists/);
  assert.deepEqual(f.calls(), []);
});

test('owned same-root update retains exact prior directory backup; replay and plan do not republish', t => {
  const f = fixture(t); good(f.invoke(['--apply']));
  const prior = snapshot(f.target); nextRelease(f.build);
  const planBefore = snapshot(f.temp);
  assert.equal(good(f.invoke(['--plan'])).publication, 'update-with-backup');
  assert.deepEqual(snapshot(f.temp), planBefore);
  const count = f.calls().length, updated = good(f.invoke(['--apply']));
  assert.equal(updated.publication, 'update-with-backup');
  assert.equal(updated.activation.existingEnabledStatesPreserved, true);
  assert.equal(updated.activation.before['ship-flow'].enabled, true);
  assert.equal(updated.activation.after['ship-flow'].enabled, true);
  assert.deepEqual(snapshot(updated.backup), prior);
  assert.equal(readJson(join(f.target, 'plugins/ship-flow/.codex-plugin/plugin.json')).version, '0.11.1');
  assert.ok(f.calls().slice(count).every(c => c.args[1] !== 'marketplace' || c.args[2] !== 'add'));
  const installed = snapshot(f.target), repeat = good(f.invoke(['--apply']));
  assert.equal(repeat.publication, 'already-current'); assert.equal(repeat.backup, null);
  assert.deepEqual(snapshot(f.target), installed);
});

const blockedActivations = [
  ['engine disabled', state => { state.installed.find(p => p.name === 'loop-engine').enabled = false; }, /Existing core activation is disabled/],
  ['ship-flow disabled', state => { state.installed.find(p => p.name === 'ship-flow').enabled = false; }, /Existing core activation is disabled/],
  ['missing enabled state', state => { delete state.installed[0].enabled; }, /Existing core activation is unknown/],
  ['null enabled state', state => { state.installed[0].enabled = null; }, /Existing core activation is unknown/],
  ['nonboolean enabled state', state => { state.installed[0].enabled = 'true'; }, /Existing core activation is unknown/],
  ['missing installed state', state => { delete state.installed[0].installed; }, /Unknown or ambiguous installed core/],
  ['ambiguous installed core', state => { state.installed.push({ ...state.installed[0] }); }, /Unknown or ambiguous installed core/],
  ['unknown installed source', state => { delete state.installed[0].marketplaceSource; }, /Unknown or ambiguous installed core/],
];
for (const [name, change, pattern] of blockedActivations) test(`${name} preserves destination, cache and activation before publication`, t => {
  const f = fixture(t); good(f.invoke(['--apply'])); nextRelease(f.build);
  const statePath = join(f.home, 'fake-state.json'), state = readJson(statePath);
  change(state); writeFileSync(statePath, json(state));
  const planBefore = snapshot(f.temp);
  assert.equal(good(f.invoke(['--plan'])).publication, 'update-with-backup');
  assert.deepEqual(snapshot(f.temp), planBefore);
  const targetBefore = snapshot(f.target), cacheBefore = snapshot(join(f.home, 'plugins'));
  const activationBefore = snapshot(statePath), calls = f.calls().length;
  bad(f.invoke(['--apply']), pattern);
  assert.deepEqual(snapshot(f.target), targetBefore);
  assert.deepEqual(snapshot(join(f.home, 'plugins')), cacheBefore);
  assert.deepEqual(snapshot(statePath), activationBefore);
  assert.deepEqual(f.calls().slice(calls).map(c => c.args), [['plugin', 'marketplace', 'list', '--json'], ['plugin', 'list', '--json']]);
  assert.ok(!readdirSync(f.temp).some(p => /\.stage-|\.backup-|\.lock$/.test(p)));
  assert.equal(readJson(join(f.target, 'plugins/ship-flow/.codex-plugin/plugin.json')).version, '0.11.0');
});

test('disabled core blocks an already-current apply without reinstalling or changing activation', t => {
  const f = fixture(t); good(f.invoke(['--apply']));
  const statePath = join(f.home, 'fake-state.json'), state = readJson(statePath);
  state.installed[0].enabled = false; writeFileSync(statePath, json(state));
  assert.equal(good(f.invoke(['--plan'])).publication, 'already-current');
  const prior = snapshot(f.target), activation = snapshot(statePath), calls = f.calls().length;
  bad(f.invoke(['--apply']), /Existing core activation is disabled/);
  assert.deepEqual(snapshot(f.target), prior); assert.deepEqual(snapshot(statePath), activation);
  assert.deepEqual(f.calls().slice(calls).map(c => c.args), [['plugin', 'marketplace', 'list', '--json'], ['plugin', 'list', '--json']]);
});

test('disabled optional memory and another marketplace core keep their activation states', t => {
  const f = fixture(t); good(f.invoke(['--apply'])); nextRelease(f.build);
  const statePath = join(f.home, 'fake-state.json'), state = readJson(statePath);
  const unrelated = [
    { pluginId: 'loop-memory@paul-loop-codex', name: 'loop-memory', marketplaceName: 'paul-loop-codex', installed: true, enabled: false },
    { pluginId: 'loop-engine@another', name: 'loop-engine', marketplaceName: 'another', installed: true, enabled: false },
  ];
  state.installed.push(...unrelated); writeFileSync(statePath, json(state));
  good(f.invoke(['--apply']));
  assert.deepEqual(readJson(statePath).installed.filter(p => unrelated.some(u => u.pluginId === p.pluginId)), unrelated);
});

test('registered marketplace with no installed cores permits a clean installation', t => {
  const f = fixture(t);
  bad(f.invoke(['--apply'], { FAKE_FAIL: 'loop-engine' }), /plugin installation failed/);
  const result = good(f.invoke(['--apply']));
  for (const name of ['loop-engine', 'ship-flow']) {
    assert.deepEqual(result.activation.before[name], { installed: false, enabled: null });
    assert.equal(result.activation.after[name].enabled, true);
  }
});

for (const failure of ['post-disabled', 'post-unknown', 'post-missing', 'post-version']) test(`${failure} in final plugin list fails instead of claiming preserved activation`, t => {
  const f = fixture(t);
  bad(f.invoke(['--apply'], { FAKE_FAIL: failure }), /Post-install|Unknown or ambiguous installed core/);
  assert.deepEqual(f.calls().at(-1).args, ['plugin', 'list', '--json']);
  assert.ok(f.calls().some(c => c.args.includes('ship-flow@paul-loop-codex')));
  assert.equal(existsSync(f.target), true);
});

const localEdits = [
  ['content', f => writeFileSync(join(f.target, 'plugins/loop-engine/NOTICE'), 'my local edits'), /Hash\/mode mismatch/],
  ['mode', f => chmodSync(join(f.target, 'plugins/loop-engine/NOTICE'), 0o600), /Hash\/mode mismatch/],
  ['directory mode', f => chmodSync(join(f.target, 'plugins'), 0o700), /edited directory/],
  ['extra file', f => writeFileSync(join(f.target, 'local-note.txt'), 'keep'), /Unexpected file/],
  ['missing file', f => rmSync(join(f.target, 'plugins/loop-engine/NOTICE')), /Missing file/],
  ['receipt source', f => updateJson(f.target, receipt, i => { i.sourceIdentity = 'https://example.invalid/fork'; }, false), /Ownership\/source\/root/],
  ['receipt root', f => updateJson(f.target, receipt, i => { i.targetRoot += '-moved'; }, false), /Ownership\/source\/root/],
];
for (const [name, change, pattern] of localEdits) test(`preserves existing ${name} on attempted update`, t => {
  const f = fixture(t); good(f.invoke(['--apply'])); nextRelease(f.build); change(f);
  const before = snapshot(f.temp), calls = f.calls();
  bad(f.invoke(['--apply']), pattern);
  assert.deepEqual(snapshot(f.temp), before); assert.deepEqual(f.calls(), calls);
});

const conflicts = [
  ['different source', f => ({ name: 'paul-loop-codex', root: f.target, marketplaceSource: { sourceType: 'local', source: f.home } })],
  ['different root', f => ({ name: 'paul-loop-codex', root: f.home, marketplaceSource: { sourceType: 'local', source: f.target } })],
  ['Git source', f => ({ name: 'paul-loop-codex', root: f.target, marketplaceSource: { sourceType: 'git', source: f.target } })],
  ['different name at target', f => ({ name: 'foreign-market', root: f.target, marketplaceSource: { sourceType: 'local', source: f.target } })],
  ['different name at normalized target', f => ({ name: 'foreign-market', root: `${f.target}/.`, marketplaceSource: { sourceType: 'local', source: `${f.target}/.` } })],
  ['missing source identity', f => ({ name: 'paul-loop-codex', root: f.target })],
];
for (const [name, market] of conflicts) test(`existing marketplace ${name} blocks publication and mutating CLI`, t => {
  const f = fixture(t); good(f.invoke(['--apply'])); nextRelease(f.build);
  f.setMarkets([market(f)]);
  const prior = snapshot(f.target), calls = f.calls().length, state = readFileSync(join(f.home, 'fake-state.json'));
  bad(f.invoke(['--apply']), /Marketplace identity conflict/);
  assert.deepEqual(snapshot(f.target), prior);
  assert.deepEqual(f.calls().slice(calls).map(c => c.args), [['plugin', 'marketplace', 'list', '--json']]);
  assert.deepEqual(readFileSync(join(f.home, 'fake-state.json')), state);
  assert.ok(!readdirSync(f.temp).some(p => /\.stage-|\.backup-|\.lock$/.test(p)));
});

test('foreign registration is not replaced even on initial installation', t => {
  const f = fixture(t); f.setMarkets([conflicts[0][1](f)]);
  bad(f.invoke(['--apply']), /Marketplace identity conflict/);
  assert.equal(existsSync(f.target), false); assert.equal(f.calls().length, 1);
});

test('duplicate configured marketplace identity is refused', t => {
  const f = fixture(t), market = { name: 'paul-loop-codex', root: f.target, marketplaceSource: { sourceType: 'local', source: f.target } };
  f.setMarkets([market, market]);
  bad(f.invoke(['--apply']), /Marketplace identity conflict/);
  assert.equal(existsSync(f.target), false); assert.equal(f.calls().length, 1);
});

test('a registration pointing at a missing target does not confer ownership', t => {
  const f = fixture(t); f.setMarkets([{ name: 'paul-loop-codex', root: f.target, marketplaceSource: { sourceType: 'local', source: f.target } }]);
  bad(f.invoke(['--apply']), /no owned installation/);
  assert.equal(existsSync(f.target), false); assert.equal(f.calls().length, 1);
});

test('directory rename failure restores the old installation before any mutating CLI', t => {
  const f = fixture(t); good(f.invoke(['--apply'])); nextRelease(f.build);
  const prior = snapshot(f.target), calls = f.calls().length;
  // Inject one OS rename error in the installer subprocess, after the old root was moved.
  // The rest of preparation, subprocesses, filesystem publication and rollback remain real.
  const fault = join(f.temp, 'rename-fault.mjs');
  writeFileSync(fault, `import fs from 'node:fs';\nimport {syncBuiltinESMExports} from 'node:module';\nconst rename=fs.renameSync;\nfs.renameSync=(from,to)=>{if(from.includes('.stage-'))throw new Error('injected EIO publishing stage');return rename(from,to);};\nsyncBuiltinESMExports();\n`);
  bad(f.invoke(['--apply'], { NODE_OPTIONS: `--import ${JSON.stringify(fault)}` }), /injected EIO/);
  assert.deepEqual(snapshot(f.target), prior);
  assert.deepEqual(f.calls().slice(calls).map(c => c.args), [['plugin', 'marketplace', 'list', '--json'], ['plugin', 'list', '--json']]);
});

test('rollback failure keeps the intact backup and reports interruption instead of no change', t => {
  const f = fixture(t); good(f.invoke(['--apply'])); nextRelease(f.build);
  const prior = snapshot(f.target), fault = join(f.temp, 'rollback-fault.mjs');
  writeFileSync(fault, `import fs from 'node:fs';\nimport {syncBuiltinESMExports} from 'node:module';\nconst rename=fs.renameSync;\nfs.renameSync=(from,to)=>{if(from.includes('.stage-')||from.includes('.backup-'))throw new Error('injected rename EIO');return rename(from,to);};\nsyncBuiltinESMExports();\n`);
  const result = f.invoke(['--apply'], { NODE_OPTIONS: `--import ${JSON.stringify(fault)}` });
  bad(result, /Marketplace publication: interrupted/);
  const backups = readdirSync(f.temp).filter(p => p.includes('.backup-'));
  assert.equal(backups.length, 1); assert.deepEqual(snapshot(join(f.temp, backups[0])), prior);
  assert.equal(existsSync(f.target), false);
  renameSync(join(f.temp, backups[0]), f.target);
  good(f.invoke(['--apply']));
});

for (const failure of ['remove-stage', 'edit-stage']) test(`preflight ${failure} is caught before publication`, t => {
  const f = fixture(t); good(f.invoke(['--apply'])); nextRelease(f.build);
  const prior = snapshot(f.target), calls = f.calls().length;
  bad(f.invoke(['--apply'], { FAKE_FAIL: failure }), /Unsafe or edited directory|Hash\/mode mismatch/);
  assert.deepEqual(snapshot(f.target), prior); assert.equal(f.calls().length, calls + 2);
});

test('a concurrent edit during CLI preflight is preserved and blocks publication', t => {
  const f = fixture(t); good(f.invoke(['--apply'])); nextRelease(f.build);
  const calls = f.calls().length;
  bad(f.invoke(['--apply'], { FAKE_FAIL: 'mutate-target' }), /Hash\/mode mismatch/);
  assert.equal(readFileSync(join(f.target, 'plugins/loop-engine/NOTICE'), 'utf8'), 'concurrent local edit');
  assert.equal(readJson(join(f.target, 'plugins/ship-flow/.codex-plugin/plugin.json')).version, '0.11.0');
  assert.equal(f.calls().length, calls + 2);
});

for (const failure of ['list', 'bad-list', 'plugin-list', 'bad-plugin-list', 'null-plugin-list', 'marketplace-add', 'loop-engine', 'ship-flow', 'version', 'cache']) test(`CLI ${failure} error is actionable failure, stops dependent commands, and keeps published evidence`, t => {
  const f = fixture(t);
  bad(f.invoke(['--apply'], { FAKE_FAIL: failure }), /Completed CLI commands:/);
  const calls = f.calls();
  const preflightFailure = ['list', 'bad-list', 'plugin-list', 'bad-plugin-list', 'null-plugin-list'].includes(failure);
  assert.equal(existsSync(f.target), !preflightFailure);
  if (failure !== 'ship-flow') assert.ok(!calls.some(c => c.args.includes('ship-flow@paul-loop-codex')));
  assert.ok(!readdirSync(f.temp).some(p => /\.stage-|\.lock$/.test(p)));
  if (!preflightFailure) good(f.invoke(['--apply']));
});

test('CLI failure after update retains backup and reports the actual partial state', t => {
  const f = fixture(t); good(f.invoke(['--apply'])); nextRelease(f.build);
  const prior = snapshot(f.target), result = f.invoke(['--apply'], { FAKE_FAIL: 'ship-flow' });
  bad(result, /published; retained for inspection\/retry/);
  const backups = readdirSync(f.temp).filter(p => p.includes('.backup-'));
  assert.equal(backups.length, 1); assert.deepEqual(snapshot(join(f.temp, backups[0])), prior);
  assert.equal(readJson(join(f.target, 'plugins/ship-flow/.codex-plugin/plugin.json')).version, '0.11.1');
  assert.match(result.stderr, /loop-engine@paul-loop-codex/);
  good(f.invoke(['--apply'])); assert.equal(readdirSync(f.temp).filter(p => p.includes('.backup-')).length, 1);
});

test('later plugin installation cannot invalidate an earlier cache and still report success', t => {
  const f = fixture(t);
  const result = f.invoke(['--apply'], { FAKE_FAIL: 'post-cache' });
  bad(result, /Hash\/mode mismatch/);
  assert.ok(f.calls().some(c => c.args.includes('ship-flow@paul-loop-codex')));
  assert.match(result.stderr, /published; retained for inspection\/retry/);
  assert.equal(result.stdout, '');
});

test('official CLI ingestion in a disposable CODEX_HOME (opt-in)', { skip: process.env.PAUL_LOOP_TEST_REAL_CODEX !== '1' }, t => {
  const f = fixture(t, true);
  const result = good(f.invoke(['--apply']));
  assert.equal(result.status, 'installed');
  for (const name of ['loop-engine', 'ship-flow']) {
    assert.deepEqual(result.activation.before[name], { installed: false, enabled: null });
    assert.equal(result.activation.after[name].enabled, true);
  }
  // Model a later provider revision with identical release payloads: exercise publication again
  // without inventing package versions or changing the user's installation/configuration.
  updateJson(f.build, 'provenance.json', value => { value.sourceCommit = 'b'.repeat(40); });
  const updated = good(f.invoke(['--apply']));
  assert.equal(updated.publication, 'update-with-backup');
  assert.deepEqual(updated.activation.before, result.activation.after);
  assert.deepEqual(updated.activation.after, updated.activation.before);
  assert.equal(updated.activation.existingEnabledStatesPreserved, true);
  const replay = good(f.invoke(['--apply'])); assert.equal(replay.publication, 'already-current');
  const list = spawnSync('codex', ['plugin', 'list', '--json'], { cwd: f.temp, env: f.env, encoding: 'utf8', timeout: 30000 });
  const installed = good(list).installed;
  assert.deepEqual(installed.map(p => p.pluginId).sort(), ['loop-engine@paul-loop-codex', 'ship-flow@paul-loop-codex']);
  assert.ok(installed.every(p => p.installed === true && p.enabled === true));
  const config = readFileSync(join(f.home, 'config.toml'), 'utf8');
  assert.doesNotMatch(config, /trusted|hooks|credentials|api_key|token/i);
  assert.equal(existsSync(join(f.home, 'auth.json')), false);
});
