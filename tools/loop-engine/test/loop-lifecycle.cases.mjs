import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const engine = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const loop = join(engine, 'bin/loop-fix.sh');
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(LOOP_|VERDICT_RUN_|CLAUDE_|GIT_)/.test(key)));
Object.assign(env, { LOOP_PROTECT_GRACE_SEC: '0', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
function cmd(cwd, args, extra = {}) {
  const r = spawnSync(args[0], args.slice(1), { cwd, env: { ...env, ...extra }, encoding: 'utf8', timeout: 15000 });
  if (r.error) throw r.error;
  return r;
}
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'loop-lifecycle-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function gitRepo(root) {
  mkdirSync(root, { recursive: true }); writeFileSync(join(root, '.gitignore'), '.loop/\n'); writeFileSync(join(root, 'source'), 'original');
  for (const args of [['init', '-qb', 'main'], ['add', '.'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@local', 'commit', '-qm', 'initial']]) assert.equal(cmd(root, ['git', ...args]).status, 0);
}
function start(t, root, args, extra = {}) {
  const p = spawn(loop, args, { cwd: root, env: { ...env, ...extra }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; p.stdout.on('data', (s) => { output += s; }); p.stderr.on('data', (s) => { output += s; });
  const done = new Promise((r, reject) => { p.once('error', reject); p.once('exit', (code, signal) => r({ code, signal, output })); });
  t.after(() => { try { p.kill('SIGTERM'); } catch {} });
  return { p, done };
}
async function until(fn, message) {
  for (let i = 0; i < 200; i++) { if (fn()) return; await delay(25); }
  assert.fail(message);
}
function state(root) {
  const dir = join(root, '.loop/lifecycle');
  return json(join(dir, readdirSync(dir).find((f) => f.endsWith('.json'))));
}
function hook(root, name, payload, extra = {}) {
  return spawnSync(process.execPath, [join(engine, 'hooks', name)], { cwd: root, env: { ...env, CLAUDE_PROJECT_DIR: root, ...extra }, input: JSON.stringify(payload), encoding: 'utf8' });
}
const decision = (r) => r.stdout ? JSON.parse(r.stdout).hookSpecificOutput.permissionDecision : 'allow';

test('restore refuses replaced symlink ancestors, including identical outside bytes', (t) => {
  for (const outsideBytes of ['OUTSIDE', 'ORIGINAL']) {
    const base = fixture(t), root = join(base, 'work'), outside = join(base, 'outside');
    mkdirSync(join(root, 'tests'), { recursive: true }); mkdirSync(outside);
    writeFileSync(join(root, 'tests/check.test.sh'), 'ORIGINAL');
    const target = join(outside, 'check.test.sh'); writeFileSync(target, outsideBytes, { mode: 0o600 });
    const mode = statSync(target).mode;
    const r = cmd(root, [loop, '--verify', 'false', '--fix', 'mv tests saved-tests; ln -s ../outside tests', '--protect', 'tests/*.test.sh', '--max-iter', '2']);
    assert.equal(r.status, 3, r.stdout + r.stderr);
    assert.equal(readFileSync(target, 'utf8'), outsideBytes, 'restore must never follow the redirected ancestor');
    assert.equal(statSync(target).mode, mode, 'even identical outside bytes must not be chmodded');
    assert.ok(existsSync(join(root, '.loop/protect-compromised')), 'unsafe restore remains explicitly compromised');
    assert.equal(readFileSync(join(root, 'saved-tests/check.test.sh'), 'utf8'), 'ORIGINAL');
  }
});

test('cancellation restore rejects a symlink ancestor before its identical-byte fast path', async (t) => {
  const base = fixture(t), root = join(base, 'work'), outside = join(base, 'outside');
  mkdirSync(join(root, 'tests'), { recursive: true }); mkdirSync(outside);
  writeFileSync(join(root, 'tests/check.test.sh'), 'ORIGINAL'); writeFileSync(join(outside, 'check.test.sh'), 'ORIGINAL', { mode: 0o600 });
  const a = start(t, root, ['--verify', 'mv tests saved-tests; ln -s ../outside tests; touch .loop/ready; sleep 30', '--protect', 'tests/*.test.sh']);
  await until(() => existsSync(join(root, '.loop/ready')), 'verifier did not replace the ancestor');
  a.p.kill('SIGTERM'); assert.equal((await a.done).code, 130);
  assert.ok(existsSync(join(root, '.loop/protect-compromised')), 'the supervisor must not skip the unsafe path because its referent matches');
  assert.equal(readFileSync(join(outside, 'check.test.sh'), 'utf8'), 'ORIGINAL');
  assert.equal(statSync(join(outside, 'check.test.sh')).mode & 0o777, 0o600);
});

test('supervisor detects new protected paths created after the worker final check', (t) => {
  const root = fixture(t); mkdirSync(join(root, 'tests')); mkdirSync(join(root, '.loop/fakebin'), { recursive: true });
  writeFileSync(join(root, 'tests/check.test.sh'), 'ORIGINAL');
  // Hold the worker's real PASS log call until its child acknowledges the write. This fixes the
  // event order without relying on machine-dependent startup delays or modifying engine source.
  const tee = cmd(root, ['which', 'tee']).stdout.trim();
  writeFileSync(join(root, '.loop/fakebin/tee'), `#!/bin/sh\n'${tee}' "$@"\nif grep -q '^iter .*PASS — stopping' .loop/history.log; then\n  tries=0; until [ -f .loop/late-created ]; do tries=$((tries + 1)); [ "$tries" -lt 500 ] || exit 9; sleep 0.01; done\nfi\n`, { mode: 0o755 });
  writeFileSync(join(root, 'child.cjs'), `const fs=require('fs'); const end=Date.now()+5000;
    function check(){if(fs.existsSync('.loop/history.log') && /^iter .*PASS — stopping/m.test(fs.readFileSync('.loop/history.log','utf8'))){fs.writeFileSync('tests/late.test.sh','LATE');fs.writeFileSync('.loop/late-created','yes');return;} if(Date.now()<end)setTimeout(check,5);}check();`);
  writeFileSync(join(root, 'verify.cjs'), "require('child_process').spawn(process.execPath,['child.cjs'],{stdio:'ignore'}).unref();");
  const r = cmd(root, [loop, '--verify', 'node verify.cjs', '--protect', 'tests/*.test.sh', '--max-iter', '1'], { PATH: join(root, '.loop/fakebin') + ':' + env.PATH });
  assert.ok(existsSync(join(root, '.loop/late-created')), 'the actual late write must occur before the supervisor handoff');
  assert.equal(r.status, 3, r.stdout + r.stderr); assert.equal(state(root).status, 'protected_violation');
  assert.equal(existsSync(join(root, 'tests/late.test.sh')), false, 'remove the rogue matching path after fencing descendants');
  assert.equal(readFileSync(join(root, 'tests/check.test.sh'), 'utf8'), 'ORIGINAL');
  assert.equal(json(join(root, '.loop/verdict-state.json')).verdict, 'FAIL');
});

test('receipt storage failure cannot become a successful lifecycle or silent checkpoint', (t) => {
  const root = fixture(t); mkdirSync(join(root, '.loop')); writeFileSync(join(root, '.loop/evidence'), 'not a directory');
  const r = cmd(root, [loop, '--verify', 'true', '--max-iter', '1']);
  assert.equal(r.status, 2, r.stdout + r.stderr); assert.equal(state(root).status, 'incomplete');
  assert.equal(state(root).attempt, 1); assert.deepEqual(state(root).evidence, []);
  assert.match(r.stderr, /receipt|evidence|ENOENT|ENOTDIR/); assert.doesNotMatch(r.stdout, /done: SUCCESS/);
  assert.equal(json(join(root, '.loop/verdict-state.json')).verdict, 'FAIL');
  assert.equal(existsSync(join(root, '.loop/looping')), false); assert.equal(existsSync(join(root, '.loop/lifecycle/lease')), false);
});

test('final handoff requires the PASS receipt even after a successful worker checkpoint', (t) => {
  const root = fixture(t); mkdirSync(join(root, '.loop/fakebin'), { recursive: true });
  const tee = cmd(root, ['which', 'tee']).stdout.trim();
  writeFileSync(join(root, '.loop/fakebin/tee'), `#!/bin/sh\n'${tee}' "$@"\nif grep -q '^iter .*PASS — stopping' .loop/history.log; then rm -f .loop/verdict-state.json; touch .loop/deleted-after-pass; fi\n`, { mode: 0o755 });
  const r = cmd(root, [loop, '--verify', 'true', '--max-iter', '1'], { PATH: join(root, '.loop/fakebin') + ':' + env.PATH });
  assert.ok(existsSync(join(root, '.loop/deleted-after-pass')));
  assert.equal(r.status, 2, r.stdout + r.stderr); assert.equal(state(root).status, 'incomplete');
  assert.equal(state(root).evidence.length, 1, 'retain the real earlier receipt as historical evidence');
  assert.equal(json(join(root, '.loop/verdict-state.json')).verdict, 'FAIL');
});

test('unreadable lifecycle state cannot refund a reserved attempt through error recovery', (t) => {
  const root = fixture(t);
  const r = cmd(root, [loop, '--verify', 'printf "{" > "$LOOP_LIFECYCLE_STATE"; true']);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  const name = readdirSync(join(root, '.loop/lifecycle')).find((f) => f.endsWith('.json'));
  assert.equal(readFileSync(join(root, '.loop/lifecycle', name), 'utf8'), '{', 'do not manufacture valid state with reset counters');
  assert.equal(cmd(root, [loop, '--resume', name.slice(0, -5)]).status, 2);
  assert.equal(json(join(root, '.loop/verdict-state.json')).verdict, 'FAIL');
});

test('long absolute budgets do not overflow Node timers into an immediate cancellation', (t) => {
  const root = fixture(t);
  const r = cmd(root, [loop, '--verify', 'true', '--budget-sec', '2147484']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(state(root).status, 'succeeded');
  const saved = state(root);
  assert.equal(Date.parse(saved.deadline_at) - Date.parse(saved.started_at), 2147484000, 'preserve the exact long budget independently of fixture runtime');
});

test('root and nested protect globs reject root verifier tampering; each pattern must match', (t) => {
  const root = fixture(t); mkdirSync(join(root, 'sub')); writeFileSync(join(root, 'root.test.sh'), 'original'); writeFileSync(join(root, 'sub/other.test.sh'), 'control');
  const r = cmd(root, [loop, '--verify', 'test "$(cat root.test.sh)" = cheat', '--fix', 'echo cheat > root.test.sh', '--protect', '**/*.test.sh', '--max-iter', '2']);
  assert.equal(r.status, 3, r.stdout + r.stderr); assert.equal(readFileSync(join(root, 'root.test.sh'), 'utf8'), 'original');
  const bad = cmd(root, [loop, '--verify', 'touch invoked', '--protect', '**/*.test.sh', '--protect', 'missing/*.test.sh']);
  assert.equal(bad.status, 2); assert.equal(existsSync(join(root, 'invoked')), false);
});

test('Stop judges the linked worktree and cannot borrow the main PASS', (t) => {
  const root = fixture(t), main = join(root, 'main'), wt = join(root, 'wt'); gitRepo(main);
  assert.equal(cmd(main, ['git', 'worktree', 'add', '-qb', 'feature/a', wt]).status, 0);
  mkdirSync(join(main, '.loop')); mkdirSync(join(wt, '.loop')); writeFileSync(join(wt, '.loop/looping'), '');
  const sha = cmd(wt, ['git', 'rev-parse', 'HEAD']).stdout.trim();
  writeFileSync(join(main, '.loop/verdict-state.json'), JSON.stringify({ verdict: 'PASS', sha, dirty: false }));
  writeFileSync(join(wt, '.loop/verdict-state.json'), '{"verdict":"FAIL"}');
  const r = hook(main, 'gate-stop-verdict.mjs', { cwd: wt, session_id: 's' }); assert.equal(r.status, 2, r.stdout + r.stderr);
  writeFileSync(join(wt, '.loop/verdict-state.json'), JSON.stringify({ verdict: 'PASS', sha, dirty: false }));
  assert.equal(hook(main, 'gate-stop-verdict.mjs', { cwd: wt, session_id: 's' }).status, 0);
});

test('an unapproved second worktree asks on every retry', (t) => {
  const root = fixture(t); gitRepo(root); assert.equal(cmd(root, ['git', 'update-ref', 'refs/remotes/origin/main', 'HEAD']).status, 0);
  const run = (branch) => hook(root, 'gate-worktree-create.mjs', { cwd: root, session_id: 's', tool_name: 'Bash', tool_input: { command: `git worktree add -b feature/${branch} '${join(root, '.loop', branch)}' origin/main` } });
  assert.equal(decision(run('first')), 'allow');
  assert.equal(cmd(root, ['git', 'worktree', 'add', '-qb', 'feature/first', join(root, '.loop/first'), 'origin/main']).status, 0);
  assert.equal(decision(run('second')), 'ask'); assert.equal(decision(run('second')), 'ask');
  assert.deepEqual(json(join(root, '.loop/worktree-gate.s.json')).branches, ['feature/first']);
});

test('hard budget rejects late PASS and stops a noisy fixer', async (t) => {
  const root = fixture(t); const begin = Date.now();
  const a = start(t, root, ['--verify', 'sleep 3; true', '--budget-sec', '1']);
  assert.equal((await a.done).code, 1); assert.ok(Date.now() - begin < 2500); assert.equal(state(root).status, 'exhausted');
  const other = join(root, 'other'); mkdirSync(other);
  const b = start(t, other, ['--verify', 'echo FAILED unit; false', '--fix', 'touch .loop/fixer-started; while :; do echo active; sleep .1; done', '--budget-sec', '3']);
  await until(() => existsSync(join(other, '.loop/fixer-started')), 'noisy fixer must actually execute before the budget is exhausted');
  assert.equal((await b.done).code, 1); assert.equal(state(other).status, 'exhausted');
  assert.equal(json(join(other, '.loop/verdict-state.json')).verdict, 'FAIL');
});

test('exclusive workspace lease rejects another loop even with a different loop-dir', async (t) => {
  const root = fixture(t); gitRepo(root);
  const a = start(t, root, ['--verify', 'touch .loop/ready; while [ ! -f .loop/release ]; do sleep .05; done']);
  await until(() => existsSync(join(root, '.loop/ready')), 'first verifier did not start');
  const b = cmd(root, [loop, '--verify', 'touch second-started', '--loop-dir', '.loop/other']);
  assert.equal(b.status, 2); assert.equal(existsSync(join(root, 'second-started')), false); assert.equal(existsSync(join(root, '.loop/looping')), true);
  writeFileSync(join(root, '.loop/release'), ''); assert.equal((await a.done).code, 0);
});

test('cancel kills TERM-resistant descendants before sentinel release, invalidates PASS, preserves resume counters', async (t) => {
  const root = fixture(t); gitRepo(root);
  const verify = 'if [ -f .loop/continue ]; then true; else trap "" TERM; echo $$ > .loop/child; touch .loop/ready; while :; do echo tick >> .loop/ticks; sleep .1; done; fi';
  const a = start(t, root, ['--verify', verify, '--max-iter', '4', '--budget-sec', '30']);
  await until(() => existsSync(join(root, '.loop/ready')), 'verifier not ready');
  const before = state(root); assert.equal(before.attempt, 1);
  a.p.kill('SIGTERM'); assert.equal((await a.done).code, 130);
  const ticks = readFileSync(join(root, '.loop/ticks'), 'utf8'); await delay(350); assert.equal(readFileSync(join(root, '.loop/ticks'), 'utf8'), ticks);
  assert.equal(existsSync(join(root, '.loop/looping')), false); assert.equal(json(join(root, '.loop/verdict-state.json')).verdict, 'FAIL');
  assert.equal(state(root).status, 'cancelled'); writeFileSync(join(root, '.loop/continue'), '');
  const resumed = cmd(root, [loop, '--resume', before.run_id]); assert.equal(resumed.status, 0, resumed.stdout + resumed.stderr);
  const after = state(root); assert.equal(after.run_id, before.run_id); assert.equal(after.attempt, 2); assert.equal(after.deadline_at, before.deadline_at); assert.equal(after.started_at, before.started_at);
  assert.equal(cmd(root, [loop, '--resume', before.run_id]).status, 2, 'completed run must not resume');
});

test('resume rejects modified config and target HEAD without consuming another attempt', async (t) => {
  const root = fixture(t); gitRepo(root); writeFileSync(join(root, 'package.json'), '{"name":"fixture"}');
  const args = ['--verify', 'touch .loop/ready; sleep 10', '--budget-sec', '30']; const a = start(t, root, args);
  await until(() => existsSync(join(root, '.loop/ready')), 'not ready'); a.p.kill('SIGTERM'); await a.done; const before = state(root);
  assert.equal(cmd(root, [loop, '--resume', before.run_id, '--verify', 'true']).status, 2);
  writeFileSync(join(root, 'package.json'), '{"name":"changed"}'); assert.equal(cmd(root, [loop, '--resume', before.run_id]).status, 2);
  writeFileSync(join(root, 'package.json'), '{"name":"fixture"}');
  cmd(root, ['git', 'add', '.']); cmd(root, ['git', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@local', 'commit', '-qm', 'changed']);
  assert.equal(cmd(root, [loop, '--resume', before.run_id]).status, 2); assert.equal(state(root).attempt, before.attempt);
});

test('progress clock reads the real main-worktree session ledger', async (t) => {
  const root = fixture(t), main = join(root, 'main'), wt = join(root, 'wt'); gitRepo(main);
  assert.equal(cmd(main, ['git', 'worktree', 'add', '-qb', 'feature/a', wt]).status, 0);
  mkdirSync(join(main, '.loop/runs'), { recursive: true }); writeFileSync(join(main, '.loop/runs/session.jsonl'), '');
  const verify = 'n=$(cat .loop/n 2>/dev/null || echo 0); n=$((n+1)); echo $n > .loop/n; echo FAILED case-$n; sleep .4; test $n -ge 7';
  const a = start(t, wt, ['--verify', verify, '--fix', ':', '--max-iter', '8', '--stall', '99', '--progress-timeout-sec', '3'], { CLAUDE_CODE_SESSION_ID: 'session' });
  const result = await a.done; assert.equal(result.code, 0, result.output);
  assert.match(result.output, /ledger=.*main\/\.loop\/runs\/session.jsonl/);
  assert.ok(readFileSync(join(main, '.loop/runs/session.jsonl'), 'utf8').includes('verdict.passed'));
});

test('cancel during fixer restores the original protected bytes', async (t) => {
  const root = fixture(t); writeFileSync(join(root, 'verifier.test.sh'), 'original');
  const a = start(t, root, ['--verify', 'false', '--fix', 'echo cheat > verifier.test.sh; touch .loop/fixer-ready; sleep 10', '--protect', '**/*.test.sh']);
  await until(() => existsSync(join(root, '.loop/fixer-ready')), 'fixer did not start'); a.p.kill('SIGTERM');
  assert.equal((await a.done).code, 130); assert.equal(readFileSync(join(root, 'verifier.test.sh'), 'utf8'), 'original');
  assert.equal(existsSync(join(root, '.loop/looping')), false);
});

test('resume does not refund downtime, infrastructure retry slots, or verifier attempts', async (t) => {
  const root = fixture(t); const a = start(t, root, ['--verify', 'touch .loop/ready; sleep 10', '--budget-sec', '2']);
  await until(() => existsSync(join(root, '.loop/ready')), 'not ready'); a.p.kill('SIGTERM'); await a.done; const before = state(root);
  await delay(Math.max(0, Date.parse(before.deadline_at) - Date.now()) + 50);
  assert.equal(cmd(root, [loop, '--resume', before.run_id]).status, 1); assert.equal(state(root).attempt, before.attempt); assert.equal(state(root).status, 'exhausted');
  const infra = join(root, 'infra'); mkdirSync(infra);
  const b = start(t, infra, ['--verify', 'echo Cannot connect to the Docker daemon; exit 1', '--infra-retries', '1', '--max-iter', '3']);
  await until(() => { try { return state(infra).phase === 'infra-retry'; } catch { return false; } }, 'infra retry not reached');
  b.p.kill('SIGTERM'); await b.done; const failed = state(infra); assert.equal(failed.infra_count, 1); assert.equal(failed.iteration, 0);
  const resumed = cmd(infra, [loop, '--resume', failed.run_id]); assert.equal(resumed.status, 1); assert.match(resumed.stdout, /done: INFRA/); assert.equal(state(infra).attempt, 2);
});

test('interrupted first verifier creates no fake fail-channel lesson; forged telemetry cannot extend deadline', async (t) => {
  const root = fixture(t);
  const verify = 'mkdir -p .loop/runs; while :; do echo \'{"type":"verdict.passed"}\' >> .loop/runs/unknown.jsonl; echo working; sleep .1; done';
  const a = start(t, root, ['--verify', verify, '--budget-sec', '1', '--lessons', 'lessons', '--progress-timeout-sec', '30']);
  assert.equal((await a.done).code, 1); assert.equal(state(root).status, 'exhausted'); assert.equal(existsSync(join(root, 'lessons')), false);
});

test('verification receipts retain the lifecycle run and reserved attempt, including custom loop-dir', (t) => {
  const root = fixture(t); gitRepo(root);
  mkdirSync(join(root, '.loop')); writeFileSync(join(root, '.loop/looping'), 'manual outer guard');
  const r = cmd(root, [loop, '--verify', 'true', '--loop-dir', '.loop/custom']); assert.equal(r.status, 0, r.stdout + r.stderr);
  const saved = state(root); const verdict = json(join(root, '.loop/custom/verdict-state.json'));
  assert.ok(verdict.receipt_id, 'parent verdict producer must supply a receipt'); assert.ok(saved.evidence.includes(verdict.receipt_id));
  const receipt = json(join(root, '.loop/custom/evidence', `${verdict.receipt_id}.json`));
  assert.equal(receipt.run_id, saved.run_id); assert.equal(receipt.attempt, 1);
  assert.equal(json(join(root, '.loop/verdict-state.json')).receipt_id, verdict.receipt_id);
  assert.equal(hook(root, 'gate-stop-verdict.mjs', { cwd: root, session_id: 'custom' }).status, 0, 'custom handoff PASS must reach the canonical Stop projection');
  assert.equal(readFileSync(join(root, '.loop/looping'), 'utf8'), 'manual outer guard');
});

test('a nested loop does not inherit the private worker bypass marker', (t) => {
  const root = fixture(t);
  const r = cmd(root, [loop, '--verify', `'${loop}' --verify 'touch escaped'`]);
  assert.equal(r.status, 1); assert.equal(existsSync(join(root, 'escaped')), false);
  assert.match(readFileSync(join(root, '.loop/last-run.log'), 'utf8'), /already leased/);
});

test('nested verdict FAIL EXIT7 and PASS receipts drive verified learning and an independent clean pass', (t) => {
  const root = fixture(t); gitRepo(root);
  writeFileSync(join(root, 'verify.sh'), 'test "$(cat source)" = fixed || { echo FAILED nested-case; exit 7; }\n');
  const verify = `'${join(engine, 'bin/verdict-run.sh')}' --log .loop/inner.log -- sh verify.sh`;
  const r = cmd(root, [loop, '--verify', verify, '--fix', 'printf fixed > source', '--lessons', '.loop/lessons']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const first = json(readFileSync(join(root, '.loop/first-verdict.receipt'), 'utf8').trim());
  assert.equal(first.exit, 7); assert.equal(first.attempt, 1);
  const saved = state(root); assert.equal(saved.evidence.length, 2); assert.ok(saved.evidence.includes(first.id));
  const file = join(root, '.loop/lessons', readdirSync(join(root, '.loop/lessons')).find((name) => name.endsWith('.json')));
  const learned = json(file); assert.equal(learned.verified, true); assert.equal(learned.count, 1);
  assert.equal(learned.verification.receipts[0].failure_id, first.id); assert.equal(learned.verification.receipts[0].run_id, saved.run_id);
  const clean = cmd(root, [loop, '--verify', verify, '--lessons', '.loop/lessons']);
  assert.equal(clean.status, 0, clean.stdout + clean.stderr);
  assert.equal(json(file).clean_pass_count, 1); assert.equal(json(file).count, 1);
});

test('resume preserves the original completed failure receipt for matching later PASS learning', async (t) => {
  const root = fixture(t); gitRepo(root);
  const verify = 'test "$(cat source)" = fixed || { echo FAILED resumed-case; exit 1; }';
  const a = start(t, root, ['--verify', verify, '--fix', 'touch .loop/ready; sleep 10', '--lessons', '.loop/lessons', '--budget-sec', '30']);
  await until(() => existsSync(join(root, '.loop/ready')), 'fixer did not start'); a.p.kill('SIGTERM'); await a.done;
  const before = state(root), firstPath = readFileSync(join(root, '.loop/first-verdict.receipt'), 'utf8');
  writeFileSync(join(root, 'source'), 'fixed');
  const r = cmd(root, [loop, '--resume', before.run_id]); assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(readFileSync(join(root, '.loop/first-verdict.receipt'), 'utf8'), firstPath);
  const learned = json(join(root, '.loop/lessons', readdirSync(join(root, '.loop/lessons')).find((name) => name.endsWith('.json'))));
  assert.equal(learned.verified, true); assert.equal(learned.verification.receipts[0].failure_id, json(firstPath.trim()).id);
  assert.equal(state(root).attempt, before.attempt + 1); assert.equal(state(root).deadline_at, before.deadline_at);
});

test('explicit crash recovery refuses live workers then reclaims only its own stale sentinel', async (t) => {
  const root = fixture(t); const verify = 'if [ -f .loop/continue ]; then true; else touch .loop/ready; sleep 30; fi';
  const a = start(t, root, ['--verify', verify, '--max-iter', '4']);
  await until(() => existsSync(join(root, '.loop/ready')), 'not ready'); const before = state(root);
  const killWorkers = () => { try { process.kill(-before.owner.worker_pid, 'SIGKILL'); } catch {} }; t.after(killWorkers);
  a.p.kill('SIGKILL'); await a.done;
  assert.equal(cmd(root, [loop, '--resume', before.run_id]).status, 2, 'cannot steal an orphan but active worker group');
  killWorkers(); await delay(300); writeFileSync(join(root, '.loop/continue'), '');
  const resumed = cmd(root, [loop, '--resume', before.run_id]); assert.equal(resumed.status, 0, resumed.stdout + resumed.stderr);
  assert.equal(state(root).attempt, 2); assert.equal(existsSync(join(root, '.loop/looping')), false);
});
