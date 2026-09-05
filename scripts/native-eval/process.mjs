import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

export const DEFAULT_CASE_MS = 60000;
export const MAX_CASE_MS = 300000;
export function caseBound(value = DEFAULT_CASE_MS) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_CASE_MS) throw Error('case deadline must be 1..300000 ms');
  return value;
}

// Sequential lane owner; a lock prevents two processes spending the same allowance.
export async function bounded(command, args, { cwd, env, input = '', timeoutMs = DEFAULT_CASE_MS, budgetPath } = {}) {
  const configuredTimeoutMs = caseBound(timeoutMs);
  let budget, lock;
  if (budgetPath) {
    lock = budgetPath + '.lock'; mkdirSync(lock);
    try {
      budget = JSON.parse(readFileSync(budgetPath));
      if (!Number.isFinite(budget.used_ms) || budget.used_ms < 0 || !Number.isFinite(budget.limit_ms) || budget.limit_ms > 1500000 || budget.limit_ms < 1) throw Error('invalid lane budget');
      timeoutMs = Math.min(timeoutMs, budget.limit_ms - budget.used_ms);
    } catch (e) { rmSync(lock, { recursive: true }); throw e; }
    if (timeoutMs <= 0) { rmSync(lock, { recursive: true }); return { exit: null, fault: 'budget_exhausted', duration_ms: 0, configured_timeout_ms: configuredTimeoutMs, effective_timeout_ms: 0, stdout: '', stderr: '', cleanup: null }; }
  }
  const start = performance.now();
  try {
    return await new Promise(resolve => {
      const child = spawn(command, args, { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '', stderr = '', fault = null, finished = false, killer;
      const kill = signal => { try { process.kill(-child.pid, signal); } catch (e) { if (e.code !== 'ESRCH') fault ||= 'cleanup_failed'; } };
      const stop = reason => { fault ||= reason; kill('SIGTERM'); killer ||= setTimeout(() => kill('SIGKILL'), 150); };
      const timer = setTimeout(() => stop('timeout'), Math.max(1, timeoutMs - 200));
      // An escaped descendant may retain inherited pipes after our process group
      // exits. Bound the supervisor too; group cleanup is not OS containment.
      const hardTimer = setTimeout(() => {
        stop('timeout'); kill('SIGKILL');
        child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
        done(child.exitCode);
      }, timeoutMs);
      const cancel = () => stop('cancelled');
      process.on('SIGTERM', cancel); process.on('SIGINT', cancel);
      const capture = stream => data => {
        if (stream === 'stdout') stdout += data; else stderr += data;
        if (stdout.length + stderr.length > 8 * 1024 * 1024) stop('output_limit');
      };
      child.stdout.on('data', capture('stdout')); child.stderr.on('data', capture('stderr'));
      child.stdin.on('error', () => {}); child.stdin.end(input);
      child.on('error', e => { stderr += String(e); fault = 'spawn_error'; done(null); });
      child.on('exit', code => { kill('SIGKILL'); }); // also terminate orphan descendants on successful exit
      child.on('close', done);
      function done(exit) {
        if (finished) return; finished = true;
        clearTimeout(timer); clearTimeout(hardTimer); clearTimeout(killer); process.off('SIGTERM', cancel); process.off('SIGINT', cancel);
        kill('SIGKILL');
        let cleanup = 'group_absent';
        if (child.pid) try { process.kill(-child.pid, 0); cleanup = 'group_still_present'; } catch (e) { if (e.code !== 'ESRCH') cleanup = 'unknown'; }
        const duration_ms = Math.ceil(performance.now() - start);
        if(duration_ms > timeoutMs) fault ||= 'deadline_exceeded';
        resolve({ exit, fault, duration_ms, configured_timeout_ms: configuredTimeoutMs, effective_timeout_ms: timeoutMs, stdout, stderr, cleanup });
      }
    });
  } finally {
    if (budget) { budget.used_ms += Math.ceil(performance.now() - start); writeFileSync(budgetPath, JSON.stringify(budget)); rmSync(lock, { recursive: true }); }
  }
}
