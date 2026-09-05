import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, realpathSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { writeEvidence } from '../lib/evidence-graph.mjs';
import { lessonContentHash } from '../lib/lesson-state.mjs';
const root = realpathSync(mkdtempSync(join(tmpdir(), 'loop-lesson-evidence-fixture-')));
const bin = resolve(import.meta.dirname, '../bin/lessons.mjs');
const hash = v => createHash('sha256').update(v).digest('hex');
const loop = join(root, 'trial-state');
const evidence = join(loop, 'evidence'), lessons = join(loop, 'lessons');
const sig = join(root, 'verdict.txt');
const bytes = 'VERDICT: FAIL\nEXIT: 1\nFAIL: expected widget, got missing\n';
writeFileSync(sig, bytes);
function run(args, env = {}) {
  return spawnSync(process.execPath, [bin, ...args], { cwd: root, encoding: 'utf8', env: {
    PATH: process.env.PATH, LOOP_DIR: loop, ...env,
  } });
}
const record = ['record', '--signature-file', sig, '--verified', '--fix', 'repair widget', '--gate', 'fixture verify'];
const files = () => readdirSync(lessons).filter(f => f.endsWith('.json'));
const read = () => JSON.parse(readFileSync(join(lessons, files()[0])));
function pair(overrides = {}, failOverrides = {}, shared = {}) {
  const now = Date.now(), time = n => new Date(now + n).toISOString();
  const common = { kind: 'verification', mode: 'gate', run_id: randomUUID(), root_hash: hash(root),
    command_hash: hash(JSON.stringify(['sh', '-c', 'fixture verify'])),
    target_before: { sha: 'fixture', digest: hash('stable'), dirty: false },
    target_after: { sha: 'fixture', digest: hash('stable'), dirty: false }, ...shared };
  const fail = writeEvidence(evidence, { ...common, verdict: 'FAIL', exit: 1, verdict_sha256: hash(bytes),
    target_before: { digest: hash('broken implementation') }, target_after: { digest: hash('broken implementation') },
    started_at: time(-4), finished_at: time(-3), ...failOverrides });
  const pass = writeEvidence(evidence, { ...common, verdict: 'PASS', exit: 0, verdict_sha256: hash('VERDICT: PASS\n'),
    started_at: time(-2), finished_at: time(-1), ...overrides });
  return { pass, fail, args: ['--receipt', join(evidence, `${pass.id}.json`), '--failure-receipt', join(evidence, `${fail.id}.json`)] };
}
try {
  assert.equal(run(['record', '--signature', bytes, '--verified']).status, 2);
  assert.equal(run(record).status, 2, 'a file is not verifier evidence');
  for (const [good, bad, shared] of [
    [{ verdict: 'RECORD' }, {}, {}], [{ mode: 'record' }, {}, {}],
    [{ exit: 1 }, {}, {}], [{ root_hash: hash('another checkout') }, {}, {}],
    [{ command_hash: hash('different verifier') }, {}, {}], [{ run_id: 'unrelated-run' }, {}, {}],
    [{ started_at: '2026-09-04T00:00:00Z' }, {}, {}],
    [{ target_after: { digest: hash('modified during verify') } }, {}, {}],
    [{}, { verdict_sha256: hash('unrelated failure') }, {}],
    [{}, {}, { run_id: null }],
    [{}, { target_before: { digest: hash('stable') }, target_after: { digest: hash('stable') } }, {}],
  ]) assert.equal(run([...record, ...pair(good, bad, shared).args]).status, 2, JSON.stringify([good, bad, shared]));
  const corrupt = pair();
  const file = corrupt.args[1];
  writeFileSync(file, JSON.stringify({ ...corrupt.pass, command_hash: hash('tamper') }));
  assert.equal(run([...record, ...corrupt.args]).status, 2, 'checksum mismatch');
  const first = pair();
  assert.equal(run([...record, ...first.args, '--iterations', '2']).status, 0);
  assert.equal(read().verification.receipts.length, 1);
  const before = readFileSync(join(lessons, files()[0]), 'utf8');
  const lessonFile = join(lessons, files()[0]);
  const fake = JSON.parse(before); fake.fix = 'forged fix'; fake.verification.content_hash = lessonContentHash(fake);
  writeFileSync(lessonFile, JSON.stringify(fake));
  assert.match(run(['stats']).stdout, /total=1 verified=0/, 'recomputed content hash cannot replace the sealed producer story');
  fake.verification.receipts[0].seal_id = randomUUID();
  writeFileSync(lessonFile, JSON.stringify(fake));
  assert.match(run(['stats']).stdout, /total=1 verified=0/, 'summary with nonexistent seal cannot assert verification');
  writeFileSync(lessonFile, before);
  const other = join(root, 'other-workspace'); mkdirSync(other);
  cpSync(loop, join(other, 'trial-state'), { recursive: true });
  const copied = spawnSync(process.execPath, [bin, 'stats'], { cwd: other, encoding: 'utf8',
    env: { PATH: process.env.PATH, LOOP_DIR: join(other, 'trial-state') } });
  assert.equal(copied.status, 0); assert.match(copied.stdout, /total=1 verified=0/, 'copying complete history and receipt files does not transfer workspace identity');
  const passPath = first.args[1], passBytes = readFileSync(passPath);
  rmSync(passPath);
  assert.match(run(['stats']).stdout, /total=1 verified=0/, 'seal alone cannot replace an unavailable verification receipt');
  writeFileSync(passPath, passBytes);
  assert.equal(run([...record, ...first.args, '--iterations', '900']).status, 0);
  assert.equal(readFileSync(join(lessons, files()[0]), 'utf8'), before, 'duplicate delivery must not mutate');
  const sameRun = pair({}, {}, { run_id: first.pass.run_id });
  assert.equal(run([...record, ...sameRun.args]).status, 0);
  assert.equal(read().count, 1, 'new receipt from same run cannot manufacture independent recurrences');
  for (let i = 0; i < 3; i++) assert.equal(run(['record', '--signature-file', sig, '--iterations', '99']).status, 0);
  assert.match(run(['stats']).stdout, /avg_iterations_to_green=2.00 \(over 1 verified convergence/);
  assert.match(run(['promote']).stdout, /no open recurring/, 'unverified duplicates cannot promote');
  for (let i = 0; i < 2; i++) assert.equal(run([...record, ...pair().args]).status, 0);
  assert.match(run(['promote']).stdout, /3 verified runs/);
  assert.match(run(['stats']).stdout, /open_candidates=1/);
  assert.equal(run(['mark-clean', '--gate', 'fixture verify']).status, 2);
  const clean = pair();
  const cleanArgs = ['mark-clean', '--gate', 'fixture verify', '--receipt', clean.args[1]];
  assert.equal(run(cleanArgs).status, 0);
  assert.equal(run(cleanArgs).status, 0);
  assert.equal(read().clean_pass_count, 1, 'deduplicate clean run');
  assert.equal(run(['mark-clean', '--gate', 'fixture verify', '--receipt', first.args[1]]).status, 0);
  assert.equal(read().clean_pass_count, 1, 'own recovery is not a subsequent clean run');
  const delayed = pair();
  assert.equal(run(['record', '--signature-file', sig]).status, 0);
  assert.equal(read().clean_pass_count, 0, 'recurrence resets the current clean streak');
  assert.equal(run(cleanArgs).status, 0);
  assert.equal(run(['mark-clean', '--gate', 'fixture verify', '--receipt', delayed.args[1]]).status, 0);
  assert.equal(read().clean_pass_count, 0, 'old delivered and old undelivered PASS cannot rebuild a streak after recurrence');
  assert.ok(read().clean_seen_runs.includes(clean.pass.run_id), 'replay history survives recurrence reset');
  const replayRun = pair({}, {}, { run_id: clean.pass.run_id });
  assert.equal(run(['mark-clean', '--gate', 'fixture verify', '--receipt', replayRun.args[1]]).status, 0);
  assert.equal(read().clean_pass_count, 0, 'a new receipt from an already consumed run cannot rebuild the streak either');
  const subsequent = pair();
  assert.equal(run(['mark-clean', '--gate', 'fixture verify', '--receipt', subsequent.args[1]]).status, 0);
  assert.equal(read().clean_pass_count, 1, 'only a newly started post-recurrence PASS counts');
  const id = read().id;
  assert.equal(run(['challenge', '--id', id, '--verdict', 'accept']).status, 0);
  assert.equal(run(['retire', '--id', id]).status, 0);
  assert.equal(run([...record, ...pair().args, '--fix', 'corrected repair']).status, 0);
  assert.equal(read().verification.receipts.length, 1, 'changed content resets verified recurrence count');
  assert.equal(read().challenge, null); assert.equal(read().retired, null);
  for (const cmd of ['record', 'challenge', 'retire', 'invalidate', 'mark-clean']) {
    const snapshot = readFileSync(join(lessons, files()[0]), 'utf8');
    const r = run([cmd], { LOOP_LEARNING_OFF: '1' });
    assert.equal(r.status, 2); assert.match(r.stderr, /learning_off/);
    assert.equal(readFileSync(join(lessons, files()[0]), 'utf8'), snapshot);
  }
  assert.equal(run(['stats'], { LOOP_LEARNING_OFF: '1' }).status, 0);
  mkdirSync(join(lessons, '.lock'));
  const locked = run(['invalidate', '--id', id]);
  assert.notEqual(locked.status, 0, 'must not proceed unlocked');
  assert.equal(read().invalid_at, '');
  console.log('PASS: lesson evidence integrity — receipt pairing, scope, checksum, record mode, dedup, observed metrics, content reset, learning freeze, fail-closed lock');
} finally { rmSync(root, { recursive: true, force: true }); }
