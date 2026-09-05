import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, execFileSync } from 'node:child_process';
import { patchPaths } from '../lib/patch-paths.mjs';
const hook = fileURLToPath(new URL('../hooks/protect-during-loop.mjs', import.meta.url));
const patch = (body) => `*** Begin Patch\n${body}\n*** End Patch`;
function fixture(t, custom = true) {
  const root = mkdtempSync(join(tmpdir(), 'patch guard 한글 ')); t.after(() => rmSync(root, { force: true, recursive: true }));
  mkdirSync(join(root, '.loop')); writeFileSync(join(root, '.loop/looping'), 'armed');
  if (custom) writeFileSync(join(root, '.loop/protect.globs'), '**/*.test.js\n');
  writeFileSync(join(root, 'a.test.js'), 'unchanged');
  const call = (tool, input, cwd = root, env = {}) => {
    const result = spawnSync(process.execPath, [hook], { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH, CLAUDE_PROJECT_DIR: root, ...env }, input: JSON.stringify({ tool_name: tool, tool_input: input, cwd }) });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(root, 'a.test.js'), 'utf8'), 'unchanged');
    return result.stdout ? JSON.parse(result.stdout).hookSpecificOutput?.permissionDecision : 'defer';
  };
  return { root, call };
}
test('all operations and both move endpoints are extracted without content false positives', () => {
  assert.deepEqual(patchPaths(patch('*** Add File: a.js\n+*** Delete File: fake.test.js\n*** Update File: b.test.js\n*** Move to: c.js\n@@\n-old\n+new\n*** Delete File: d.js')), ['a.js','b.test.js','c.js','d.js']);
});
test('Edit and apply_patch deny protected additions, updates, deletions and moves atomically', (t) => {
  const f = fixture(t);
  assert.equal(f.call('Edit', { file_path: join(f.root, 'a.test.js') }), 'deny');
  for (const body of ['*** Add File: new.test.js\n+x', '*** Update File: a.test.js\n@@\n-old\n+new', '*** Delete File: a.test.js', '*** Update File: a.test.js\n*** Move to: ordinary.js\n@@\n-old\n+new', '*** Update File: ordinary.js\n*** Move to: a.test.js\n@@\n-old\n+new', '*** Add File: safe.js\n+x\n*** Delete File: a.test.js']) {
    assert.equal(f.call('apply_patch', { command: patch(body) }), 'deny', body);
  }
  assert.equal(f.call('apply_patch', { command: patch('*** Add File: ordinary.js\n+x') }), 'defer');
});
test('malformed/unrecognized patches fail closed, including missing and extra trailing data', (t) => {
  const f = fixture(t);
  for (const command of [undefined, {}, '', 'diff --git a b', patch(''), patch('*** Move to: x'), patch('*** Update File: x\n*** Unknown: y'), patch('*** Add File: x\n+ok')+'\n*** Delete File: a.test.js']) {
    assert.equal(f.call('apply_patch', { command }), 'deny');
  }
});
test('relative paths resolve from payload cwd and absolute paths retain protection', (t) => {
  const f = fixture(t); mkdirSync(join(f.root, 'sub'));
  assert.equal(f.call('apply_patch', { command: patch('*** Delete File: ../a.test.js') }, join(f.root, 'sub')), 'deny');
  assert.equal(f.call('apply_patch', { command: patch(`*** Delete File: ${f.root}/a.test.js`) }), 'deny');
});
test('default authoritative state protection works without consumer globs; telemetry remains writable', (t) => {
  const f = fixture(t, false);
  for (const rel of ['.loop', '.loop/lessons', '.loop/lessons/fabricated.json', '.loop/evidence/receipt.json','.loop/lifecycle/run.json','.loop/lifecycle/lease/owner.json','.loop/.execution-lease/owner.json','.loop/verdict-state.json','.loop/stop-gate.session.json','.loop/looping']) {
    assert.equal(f.call('apply_patch', { command: patch(`*** Delete File: ${rel}`) }), 'deny', rel);
    assert.equal(f.call('Bash', { command: `rm ${rel}` }), 'deny', rel);
  }
  assert.equal(f.call('apply_patch', { command: patch('*** Add File: .loop/runs/observation.jsonl\n+{}') }), 'defer');
});

test('physical aliases cannot bypass patch protection and dangling aliases fail closed', (t) => {
  const f = fixture(t);
  symlinkSync(join(f.root, 'a.test.js'), join(f.root, 'alias.js'));
  assert.equal(f.call('apply_patch', {command:patch('*** Update File: alias.js\n@@\n-unchanged\n+bad')}), 'deny');
  symlinkSync(join(f.root, '.loop'), join(f.root, 'state-alias'));
  assert.equal(f.call('apply_patch', {command:patch('*** Add File: state-alias/evidence/new.json\n+{}')}), 'deny');
  symlinkSync(join(f.root, 'missing'), join(f.root, 'dangling'));
  assert.equal(f.call('apply_patch', {command:patch('*** Add File: dangling/file.js\n+x')}), 'deny');
});

test('feature-branch autoarm protects evidence, lifecycle and a custom LOOP_DIR without a sentinel or globs', (t) => {
  const f = fixture(t, false);
  rmSync(join(f.root, '.loop/looping'));
  execFileSync('git', ['init', '-q', f.root]);
  execFileSync('git', ['-C', f.root, 'symbolic-ref', 'HEAD', 'refs/heads/feature/runtime']);
  for (const path of ['.loop/evidence/new.json', '.loop/lifecycle/state.json', '.loop/lessons/fabricated.json']) {
    assert.equal(f.call('Edit', {file_path:join(f.root,path)}), 'deny');
    assert.equal(f.call('Write', {file_path:join(f.root,path),content:'{"verified":true}'}), 'deny');
    assert.equal(f.call('apply_patch', {command:patch(`*** Add File: ${path}\n+{}`)}), 'deny');
  }
  assert.equal(f.call('apply_patch', {command:patch('*** Add File: run-state/evidence/new.json\n+{}')}, f.root, {LOOP_DIR:'run-state'}), 'deny');
});

test('lesson summaries and configured LESSONS_DIR stay protected through direct writes, patches and aliases', (t) => {
  const f = fixture(t, false), sub = join(f.root, 'sub'); mkdirSync(sub);
  const external = mkdtempSync(join(tmpdir(), 'external lessons ')); t.after(() => rmSync(external, {recursive:true,force:true}));
  const cases = [
    {path:'.loop/lessons/fabricated.json',cwd:f.root,env:{}},
    {path:'run-state/lessons/fabricated.json',cwd:f.root,env:{LOOP_DIR:'run-state'}},
    {path:'../custom lessons/fabricated.json',cwd:sub,env:{LESSONS_DIR:'../custom lessons'}},
    {path:join(external,'fabricated.json'),cwd:f.root,env:{LESSONS_DIR:external}},
  ];
  for (const {path,cwd,env} of cases) {
    for (const tool of ['Write','Edit','MultiEdit']) assert.equal(f.call(tool,{file_path:path,content:'{"verified":true}'},cwd,env),'deny',`${tool}: ${path}`);
    assert.equal(f.call('apply_patch',{command:patch(`*** Add File: ${path}\n+{"verified":true}`)},cwd,env),'deny',path);
    assert.equal(f.call('Write',{file_path:join(f.root,'.loop/lessons/default.json')},cwd,env),'deny','overrides retain default protection');
  }
  mkdirSync(join(f.root,'.loop/lessons'));
  symlinkSync(join(f.root,'.loop/lessons'),join(f.root,'lesson-alias'));
  assert.equal(f.call('Write',{file_path:join(f.root,'lesson-alias/fabricated.json')}),'deny');
  symlinkSync(external,join(f.root,'configured-alias'));
  assert.equal(f.call('Write',{file_path:join(external,'fabricated.json')},f.root,{LESSONS_DIR:'configured-alias'}),'deny');
  assert.equal(f.call('Write',{file_path:join(f.root,'.loop/runs/observation.jsonl')}),'defer');
  assert.deepEqual(readdirSync(join(f.root,'.loop/lessons')),[]); assert.deepEqual(readdirSync(external),[]);
});

test('authorized lessons Bash producer still executes while summaries reject ordinary Write', (t) => {
  const f = fixture(t, false), cli = fileURLToPath(new URL('../bin/lessons.mjs',import.meta.url));
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  for (const [env,dir] of [[{},'.loop/lessons'],[{LOOP_DIR:'run-state'},'run-state/lessons'],[{LESSONS_DIR:'custom lessons'},'custom lessons']]) {
    const args=[cli,'record','--signature','offline guard producer fixture','--fix','bounded implementation fix'];
    assert.equal(f.call('Bash',{command:[process.execPath,...args].map(quote).join(' ')},f.root,env),'defer');
    const result=spawnSync(process.execPath,args,{cwd:f.root,encoding:'utf8',env:{PATH:process.env.PATH,HOME:f.root,...env},timeout:5000});
    assert.equal(result.status,0,result.stderr);
    const files=readdirSync(join(f.root,dir)).filter(name=>name.endsWith('.json'));assert.equal(files.length,1);
    const path=join(f.root,dir,files[0]);assert.equal(JSON.parse(readFileSync(path,'utf8')).verified,false);
    assert.equal(f.call('Write',{file_path:path,content:'{"verified":true}'},f.root,env),'deny');
  }
});
test('unreadable optional globs cannot disable built-in state protection', (t) => {
  const f = fixture(t, false); mkdirSync(join(f.root, '.loop/protect.globs'));
  assert.equal(f.call('Edit', {file_path:join(f.root,'.loop/evidence/receipt.json')}), 'deny');
  assert.equal(f.call('Bash', {command:'rm -rf .loop/lifecycle'}), 'deny');
  assert.equal(f.call('apply_patch', {command:patch('*** Add File: ordinary.js\n+x')}), 'deny');
});
