// Durable local execution state. Telemetry never updates these budgets or counters.
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readEvidence } from './evidence-graph.mjs';
export const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
export function atomicJson(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(temp, 'wx', 0o600);
    try { writeFileSync(fd, `${JSON.stringify(data)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, path);
    const directory = openSync(dirname(path), 'r');
    try { fsyncSync(directory); } finally { closeSync(directory); }
  }
  finally { rmSync(temp, { force: true }); }
}
export function alive(pid) {
  if (!Number.isInteger(pid) || pid === 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
export function identity(cwd, root, config, script) {
  let head = 'non-git';
  try { head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 }).trim(); } catch {}
  const names = ['.claude/ship-flow.config.json', 'risk-rules.json', 'package.json', 'pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', '.loop/protect.globs'];
  const files = {};
  for (const dir of new Set([cwd, root])) for (const name of names) {
    const path = join(dir, name);
    files[path] = existsSync(path) ? hash(readFileSync(path)) : null;
  }
  return { target_hash: hash(JSON.stringify({ cwd, root, head })), config_hash: hash(JSON.stringify({ config, files, worker: hash(readFileSync(script)) })) };
}
export function acquireLease(path, owner, resumeId) {
  mkdirSync(dirname(path), { recursive: true });
  try { mkdirSync(path); }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    let previous;
    try { previous = readJson(join(path, 'owner.json')); } catch { throw new Error(`unreadable lease; inspect before recovery: ${path}`); }
    if (!resumeId || previous.run_id !== resumeId || alive(previous.pid) || alive(-previous.worker_pid)) {
      throw new Error(`workspace already leased by run ${previous.run_id}; resume only after its owner and worker have stopped`);
    }
    const recovery = `${path}.recover`;
    mkdirSync(recovery); // concurrent recovery is rejected, never raced
    try {
      if (readJson(join(path, 'owner.json')).token !== previous.token) throw new Error('lease changed during recovery');
      rmSync(path, { recursive: true });
      mkdirSync(path);
    } finally { rmSync(recovery, { recursive: true, force: true }); }
  }
  atomicJson(join(path, 'owner.json'), owner);
}
export function releaseLease(path, token) {
  try { if (readJson(join(path, 'owner.json')).token === token) rmSync(path, { recursive: true }); } catch {}
}
export function parseOptions(args) {
  const config = { verify: '', fix: '', max_iter: 10, budget_sec: 0, stall: 3, infra_retries: 2, idle: 0, progress: 0, loop_dir: '.loop', lessons: '', protect: [], guard_mutation: false };
  const flags = { '--verify': 'verify', '--fix': 'fix', '--max-iter': 'max_iter', '--budget-sec': 'budget_sec', '--stall': 'stall', '--infra-retries': 'infra_retries', '--idle-timeout-sec': 'idle', '--progress-timeout-sec': 'progress', '--loop-dir': 'loop_dir', '--lessons': 'lessons' };
  let resume = null;
  const forwarded = [];
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--guard-mutation') { config.guard_mutation = true; forwarded.push(flag); continue; }
    if (!flags[flag] && flag !== '--protect' && flag !== '--resume') throw new Error(`unknown arg ${flag}`);
    if (++i === args.length) throw new Error(`${flag} requires a value`);
    const value = args[i];
    if (flag === '--resume') { resume = value; continue; }
    if (flag === '--protect') config.protect.push(value);
    else config[flags[flag]] = value;
    forwarded.push(flag, value);
  }
  for (const key of ['max_iter', 'budget_sec', 'stall', 'infra_retries', 'idle', 'progress']) {
    if (key === 'infra_retries' && config[key] === 'off') continue;
    if (!/^\d+$/.test(String(config[key])) || !Number.isSafeInteger(Number(config[key]))) throw new Error(`invalid ${key}`);
    config[key] = Number(config[key]);
    if (['max_iter', 'stall'].includes(key) && config[key] < 1) throw new Error(`${key} must be positive`);
  }
  if (config.budget_sec * 1000 + Date.now() > 8640000000000000) throw new Error('budget_sec exceeds the supported absolute date range');
  if (resume && !/^[a-zA-Z0-9_-]{1,64}$/.test(resume)) throw new Error('invalid resume run id');
  return { config, resume, forwarded };
}
export function checkpoint(file, token, phase, counters) {
  const state = readJson(file);
  if (state.owner.token !== token || state.status !== 'running') throw new Error('lifecycle owner is no longer active');
  // No verifier may start in the spawn-to-owner-write crash window. A worker whose PID was
  // never made durable cannot be safely found/fenced by a later explicit resume.
  if (state.owner.worker_pid !== process.ppid) throw new Error('worker identity is not durably registered');
  const [iteration, infra_count, stall_count, attempt, prev_fp, prev_counts] = counters;
  for (const [k, v] of Object.entries({ iteration, infra_count, stall_count, attempt })) {
    if (!/^\d+$/.test(String(v))) throw new Error(`invalid checkpoint ${k}`);
    state[k] = Number(v);
  }
  state.prev_fp = prev_fp || ''; state.prev_counts = prev_counts || ''; state.phase = phase;
  if (phase === 'verified') {
    const { receipt } = currentReceipt(state);
    if (!state.evidence.includes(receipt.id)) state.evidence.push(receipt.id);
  }
  state.updated_at = new Date().toISOString();
  atomicJson(file, state);
}

export function currentReceipt(state) {
  const verdict = readJson(join(state.loop_dir, 'verdict-state.json'));
  const dir = join(state.loop_dir, 'evidence'), receipt = readEvidence(dir, verdict.receipt_id);
  if (receipt.kind !== 'verification' || receipt.mode !== 'gate' || receipt.run_id !== state.run_id || receipt.attempt !== state.attempt) throw new Error('receipt does not belong to the reserved verifier attempt');
  if (!['PASS', 'FAIL'].includes(receipt.verdict) || receipt.verdict !== verdict.verdict || receipt.exit !== verdict.exit) throw new Error('receipt disagrees with the verdict state');
  return { receipt, path: join(dir, `${receipt.id}.json`) };
}

export function validateResume(state) {
  if (state.schema_version !== 1 || !Array.isArray(state.argv) || !state.argv.every((v) => typeof v === 'string') || !Array.isArray(state.evidence) || !Array.isArray(state.protected)) throw new Error('invalid lifecycle schema');
  for (const key of ['attempt', 'iteration', 'infra_count', 'stall_count']) if (!Number.isSafeInteger(state[key]) || state[key] < 0) throw new Error(`invalid lifecycle counter: ${key}`);
  if (state.iteration > state.attempt || !Number.isFinite(Date.parse(state.started_at)) || (state.deadline_at !== null && !Number.isFinite(Date.parse(state.deadline_at)))) throw new Error('invalid lifecycle budget');
  if (!state.owner || !Number.isInteger(state.owner.pid) || state.owner.pid <= 0) throw new Error('invalid lifecycle owner');
  for (const entry of state.protected) if (typeof entry.file !== 'string' || entry.file.startsWith('/') || entry.file.split('/').includes('..') || !/^[0-9a-f]{64}$/.test(entry.hash)) throw new Error('invalid protected baseline');
}
