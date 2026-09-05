// POSIX process-group supervisor for the Bash 3.2 worker. Node is now required for loop-fix.
// Interface for evidence graph consumers: schema_version=1, run_id, attempt (reserved BEFORE
// dispatch, includes infrastructure attempts), iteration (product-budget count), infra_count,
// deadline_at (absolute UTC, includes resume downtime), owner {pid,worker_pid,token}, status,
// evidence [receipt_id]. Only running/cancelled/interrupted states may be resumed; original
// CLI config, HEAD/cwd and known project config hashes must match. Opaque shell dependencies
// are not inferable; protect verifier scripts/config explicitly. Resuming starts a NEW verify,
// never replays a fixer or accepts an old PASS. No approval is created by this state.
// Compatibility changes: Node required; --budget-sec is now a hard dispatch/runtime deadline;
// cancellation exits 130; concurrent same-workspace or handoff-dir runs fail with exit 2;
// protected baseline symlinks/out-of-cwd/newline paths fail closed. First-verifier interruption
// intentionally records no lesson because there is no completed failure signature.
// Cleanup can take bounded time after the deadline; no new verifier/fixer is dispatched then.
// Local state is an operational guardrail, not a same-UID security boundary. SIGKILL of this
// supervisor cannot run cleanup: its lease intentionally remains, and live workers prevent resume.
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertProtectedPath, protectedFiles } from './loop-protect-files.mjs';
import { workspaceRoot } from './loop-workspace.mjs';
import { resolveLedgerTarget } from './run-ledger.mjs';
import { acquireLease, alive, atomicJson, checkpoint, currentReceipt, hash, identity, parseOptions, readJson, releaseLease, validateResume } from './loop-lifecycle-state.mjs';

function invalidate(loopDir, runId, reason) {
  atomicJson(join(loopDir, 'verdict-state.json'), { verdict: 'FAIL', exit: 1, sha: 'unknown', dirty: true, run_id: runId, finished_at: new Date().toISOString(), reason });
}
function snapshots(cwd, loopDir, patterns, backup) {
  const files = protectedFiles(cwd, loopDir, patterns, { requireEach: true });
  return files.map((file, index) => {
    const bytes = readFileSync(join(cwd, file));
    const path = join(backup, String(index)); mkdirSync(backup, { recursive: true });
    writeFileSync(path, bytes, { mode: 0o400 });
    return { file, hash: hash(bytes), mode: lstatSync(join(cwd, file)).mode & 0o777, backup: path };
  });
}
function restore(cwd, loopDir, patterns, baseline) {
  const failures = [];
  for (const entry of baseline) {
    try {
      const target = assertProtectedPath(cwd, entry.file);
      if (existsSync(target) && !lstatSync(target).isSymbolicLink() && hash(readFileSync(target)) === entry.hash) continue;
      const bytes = readFileSync(entry.backup);
      if (hash(bytes) !== entry.hash) throw new Error('backup integrity mismatch');
      mkdirSync(dirname(target), { recursive: true }); rmSync(target, { force: true });
      writeFileSync(target, bytes); chmodSync(target, entry.mode);
    } catch (e) { failures.push(`${entry.file}: ${e.message}`); }
  }
  try {
    for (const file of protectedFiles(cwd, loopDir, patterns)) {
      if (!baseline.some((entry) => entry.file === file)) rmSync(join(cwd, file));
    }
  } catch (e) { failures.push(e.message); }
  if (failures.length) appendFileSync(join(loopDir, 'protect-compromised'), `${failures.join('\n')}\n`);
}

export async function supervise(script, argv) {
  const cwd = process.cwd(); const root = workspaceRoot(cwd);
  const stateDir = join(root, '.loop', 'lifecycle');
  let parsed = parseOptions(argv), prior;
  if (parsed.resume) {
    prior = readJson(join(stateDir, `${parsed.resume}.json`));
    validateResume(prior);
    if (!['cancelled', 'interrupted', 'running'].includes(prior.status)) throw new Error(`run is terminal: ${prior.status}`);
    if (alive(prior.owner.pid) || alive(-prior.owner.worker_pid)) throw new Error('resume requires the previous owner and worker to have stopped');
    // --resume ID alone reuses the original exact argv; supplied flags must reproduce its config.
    if (!parsed.forwarded.length) parsed = { ...parseOptions(prior.argv), resume: parsed.resume };
  }
  const { config, resume, forwarded } = parsed;
  if (!config.verify) throw new Error('--verify is required');
  const loopDir = resolve(cwd, config.loop_dir);
  if (existsSync(join(loopDir, 'protect-compromised')) && readFileSync(join(loopDir, 'protect-compromised')).length) {
    console.error(`loop-fix: refusing to run — ${loopDir}/protect-compromised requires inspection`); return 4;
  }
  const fingerprints = identity(cwd, root, config, script);
  if (prior && (prior.target_hash !== fingerprints.target_hash || prior.config_hash !== fingerprints.config_hash)) throw new Error('resume target/config hash mismatch; original commands, limits, HEAD and config must be unchanged');
  if (prior) for (const entry of prior.protected) {
    assertProtectedPath(cwd, entry.file);
    if (!existsSync(join(cwd, entry.file)) || lstatSync(join(cwd, entry.file)).isSymbolicLink() || hash(readFileSync(join(cwd, entry.file))) !== entry.hash) throw new Error(`resume protected baseline mismatch: ${entry.file}`);
  }
  mkdirSync(loopDir, { recursive: true }); mkdirSync(stateDir, { recursive: true });
  const runId = prior?.run_id || randomUUID(); const stateFile = join(stateDir, `${runId}.json`);
  const owner = { pid: process.pid, worker_pid: null, token: randomUUID(), run_id: runId };
  const leases = [...new Set([join(stateDir, 'lease'), join(loopDir, '.execution-lease')])];
  const acquired = []; const sentinels = [];
  let state, child, stopping = null, deadlineTimer, baseline = [], fenced = true;
  const invalidateAll = (reason) => {
    for (const dir of new Set([loopDir, join(root, '.loop')])) invalidate(dir, runId, reason);
  };
  const killGroup = (signal) => { if (child?.pid) { try { process.kill(-child.pid, signal); } catch {} } };
  const fenceGroup = async () => {
    killGroup('SIGKILL');
    for (let i = 0; child?.pid && alive(-child.pid) && i < 100; i++) await new Promise((r) => setTimeout(r, 10));
    fenced = !child?.pid || !alive(-child.pid);
    if (!fenced) throw new Error('worker group still exists; preserving lease and sentinel for inspection');
  };
  try {
    for (const lease of leases) { acquireLease(lease, owner, resume); acquired.push(lease); }
    const started = prior?.started_at || new Date().toISOString();
    state = prior || { schema_version: 1, run_id: runId, cwd, workspace: root, loop_dir: loopDir, argv: forwarded, ...fingerprints, started_at: started,
      deadline_at: config.budget_sec ? new Date(Date.parse(started) + config.budget_sec * 1000).toISOString() : null,
      attempt: 0, iteration: 0, infra_count: 0, stall_count: 0, prev_fp: '', prev_counts: '', evidence: [],
      protected: snapshots(cwd, loopDir, config.protect, join(stateDir, `${runId}.backup`)), limits: config };
    baseline = state.protected;
    state.owner = owner; state.status = 'running'; state.phase = 'starting';
    atomicJson(stateFile, state);
    for (const file of new Set([join(root, '.loop', 'looping'), join(loopDir, 'looping')])) {
      if (!existsSync(file)) { writeFileSync(file, `${runId}\n`, { flag: 'wx' }); sentinels.push(file); }
      else if (resume && prior.owned_sentinels?.includes(file) && readFileSync(file, 'utf8').trim() === runId) sentinels.push(file);
    }
    state.owned_sentinels = [...sentinels]; atomicJson(stateFile, state);
    if (state.deadline_at && Date.now() >= Date.parse(state.deadline_at)) { state.status = 'exhausted'; atomicJson(stateFile, state); invalidateAll('BUDGET'); return 1; }
    invalidateAll('running');
    const stop = (reason) => {
      if (stopping) return;
      stopping = reason;
      try { invalidateAll(reason); } catch (e) { console.error(`loop-lifecycle: invalidation failed: ${e.message}`); }
      killGroup('SIGTERM');
      // The entire worker group is fenced before sentinel release, even if descendants ignore TERM.
      setTimeout(() => killGroup('SIGKILL'), 300).unref();
    };
    const onTerm = () => stop('CANCELLED'); const onInt = () => stop('CANCELLED');
    process.on('SIGTERM', onTerm); process.on('SIGINT', onInt);
    child = spawn('/bin/bash', [script, ...forwarded], { cwd, detached: true, stdio: 'inherit', env: {
      ...process.env, LOOP_LIFECYCLE_WORKER: '1', LOOP_LIFECYCLE_STATE: stateFile, LOOP_LIFECYCLE_TOKEN: owner.token,
      LOOP_RUN_ID: runId, LOOP_ATTEMPT: String(state.attempt), LOOP_RESUME_ITER: String(state.iteration), LOOP_RESUME_INFRA: String(state.infra_count),
      LOOP_RESUME_STALL: String(state.stall_count), LOOP_RESUME_FP: state.prev_fp, LOOP_RESUME_COUNTS: state.prev_counts,
      LOOP_LIFECYCLE_RESUME: resume ? '1' : '',
      LOOP_DIR: loopDir,
    } });
    fenced = false;
    owner.worker_pid = child.pid; state.owner = owner; atomicJson(stateFile, state);
    for (const lease of acquired) atomicJson(join(lease, 'owner.json'), owner);
    const armDeadline = () => {
      if (!state.deadline_at) return;
      const remaining = Date.parse(state.deadline_at) - Date.now();
      if (remaining <= 0) stop('BUDGET');
      else deadlineTimer = setTimeout(armDeadline, Math.min(remaining, 2147483647));
    };
    armDeadline();
    const result = await new Promise((resolveResult, reject) => {
      child.once('error', reject); child.once('exit', (code, signal) => resolveResult({ code, signal }));
    });
    clearTimeout(deadlineTimer);
    // An exited shell may have left background jobs in its group. Kill before any state/sentinel handoff.
    await fenceGroup();
    process.removeListener('SIGTERM', onTerm); process.removeListener('SIGINT', onInt);
    state = readJson(stateFile);
    if (!stopping && state.deadline_at && Date.now() >= Date.parse(state.deadline_at)) stopping = 'BUDGET';
    let code = stopping === 'CANCELLED' ? 130 : stopping ? 1 : result.code ?? 130;
    // Re-enumerate after fencing: a background writer can add matching paths after the worker's
    // last check, not just modify the baseline files. An unreadable set cannot establish success.
    if (code === 0) try {
      const current = protectedFiles(cwd, loopDir, config.protect);
      if (current.length !== baseline.length || current.some((file) => !baseline.some((entry) => entry.file === file))
          || baseline.some((entry) => hash(readFileSync(assertProtectedPath(cwd, entry.file))) !== entry.hash)) throw new Error('protected paths or contents changed');
    } catch (e) {
      code = 3;
      const line = `PROTECTED FILE MODIFIED before supervisor handoff: ${e.message}`;
      console.error(line); appendFileSync(join(loopDir, 'history.log'), `${line}\n=== loop-fix done: PROTECTED-VIOLATION ===\n`);
    }
    let incomplete = code === 2 && state.phase === 'verify';
    if (code === 0) try {
      const { receipt } = currentReceipt(state);
      if (receipt.verdict !== 'PASS' || receipt.exit !== 0 || !state.evidence.includes(receipt.id)) throw new Error('successful lifecycle requires its current PASS receipt checkpoint');
    } catch (e) { code = 2; incomplete = true; state.error = e.message; console.error(`loop-lifecycle: incomplete evidence: ${e.message}`); }
    state.status = stopping === 'CANCELLED' ? 'cancelled' : stopping === 'BUDGET' ? 'exhausted' : result.signal ? 'interrupted' : incomplete ? 'incomplete' : code === 0 ? 'succeeded' : code === 3 ? 'protected_violation' : 'failed';
    if (incomplete) {
      state.error ||= 'verification did not complete its evidence checkpoint';
      appendFileSync(join(loopDir, 'history.log'), `=== loop-fix done: INCOMPLETE — ${state.error} ===\n`);
    }
    state.finished_at = new Date().toISOString(); state.exit = code;
    if (code !== 0) {
      restore(cwd, loopDir, config.protect, baseline);
      invalidateAll(stopping || state.status);
    } else if (loopDir !== join(root, '.loop')) {
      // Stop always reads the physical worktree's canonical state, even for a custom handoff dir.
      // Preserve the producer's full evidence/freshness fields; unavailable evidence stays FAIL.
      try {
        const verdict = readJson(join(loopDir, 'verdict-state.json'));
        if (verdict.verdict === 'PASS') atomicJson(join(root, '.loop', 'verdict-state.json'), verdict);
      } catch {}
    }
    atomicJson(stateFile, state);
    // Preserve the fail-channel only when a COMPLETE earlier FAIL exists. An interrupted first
    // verification has no verdict and must not manufacture a lesson from partial output.
    if (stopping && config.lessons && existsSync(join(loopDir, 'first-verdict.txt'))) {
      spawnSync(join(dirname(script), 'lessons.sh'), ['record', '--signature-file', join(loopDir, 'first-verdict.txt'), '--source', 'loop-fix-fail', '--iterations', String(state.iteration), '--lessons', config.lessons], { cwd, stdio: 'ignore', timeout: 5000 });
    }
    if (stopping) { const line = `=== loop-fix done: ${stopping} ===`; console.error(line); appendFileSync(join(loopDir, 'history.log'), `${line}\n`); }
    return code;
  } catch (e) {
    try { await fenceGroup(); } catch {}
    if (state) {
      restore(cwd, loopDir, config.protect, baseline);
      invalidateAll('lifecycle-error');
      // Never overwrite a newer reservation with the supervisor's pre-dispatch counters.
      // Corrupt/unreadable state stays unavailable for resume instead of silently refunding work.
      try {
        const latest = readJson(stateFile); validateResume(latest);
        if (latest.owner.token !== owner.token) throw new Error('lifecycle owner changed');
        latest.status = 'interrupted'; latest.error = e.message; atomicJson(stateFile, latest);
      } catch (stateError) { console.error(`loop-lifecycle: retained unreadable state: ${stateError.message}`); }
    }
    throw e;
  } finally {
    clearTimeout(deadlineTimer); killGroup('SIGKILL');
    for (const file of fenced ? sentinels : []) { try { if (readFileSync(file, 'utf8').trim() === owner.run_id) rmSync(file); } catch {} }
    for (const lease of fenced ? acquired.reverse() : []) releaseLease(lease, owner.token);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [mode, ...args] = process.argv.slice(2);
    if (mode === 'ledger') {
      const target = resolveLedgerTarget({ cwd: process.cwd(), env: process.env });
      process.stdout.write(join(target.root, '.loop', 'runs', `${target.runId}.jsonl`));
    } else if (mode === 'checkpoint') checkpoint(process.env.LOOP_LIFECYCLE_STATE, process.env.LOOP_LIFECYCLE_TOKEN, args[0], args.slice(1));
    else if (mode === 'receipt') process.stdout.write(currentReceipt(readJson(process.env.LOOP_LIFECYCLE_STATE)).path);
    else if (mode === 'run') process.exitCode = await supervise(args[0], args.slice(1));
    else throw new Error('unknown lifecycle command');
  } catch (e) { console.error(`loop-lifecycle: ${e.message}`); process.exitCode = 2; }
}
