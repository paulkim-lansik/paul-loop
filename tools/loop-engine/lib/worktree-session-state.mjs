// A PreToolUse request is neither approval nor success. Only a later Git observation of the
// requested repository + branch + physical path confirms a creation for the session counter.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const git = (args) => execFileSync('git', args, { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] });
export function physicalPath(path) {
  const abs = resolve(path);
  if (existsSync(abs)) return realpathSync(abs);
  return join(physicalPath(dirname(abs)), basename(abs));
}
const key = (r) => `${r.repository}\0${r.branch}`;
const exact = (a, b) => key(a) === key(b) && a.path === b.path;
const record = (r) => r && ['repository', 'branch', 'path'].every((k) => typeof r[k] === 'string' && r[k]);

export function sessionState(file) {
  try {
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    if (saved.schema_version === 2) return { ...saved,
      confirmed: (saved.confirmed || []).filter(record), pending: (saved.pending || []).filter(record) };
    // Legacy branches counted attempts and carried no path; do not silently promote that history.
    return { schema_version: 2, confirmed: [], pending: [], legacy_unconfirmed: Array.isArray(saved.branches) ? saved.branches : [] };
  } catch { return { schema_version: 2, confirmed: [], pending: [] }; }
}

export function observationCache() {
  const cache = new Map();
  return (repository) => {
    if (!cache.has(repository)) {
      try {
        const output = git(['--git-dir', repository, 'worktree', 'list', '--porcelain', '-z']);
        const entries = output.split('\0\0').map((block) => {
          const fields = block.split('\0'), path = fields.find((f) => f.startsWith('worktree '))?.slice(9);
          const branch = fields.find((f) => f.startsWith('branch refs/heads/'))?.slice(18);
          return path && branch && existsSync(path) && !fields.some((f) => f.startsWith('prunable'))
            ? { repository, path: physicalPath(path), branch } : null;
        }).filter(Boolean);
        cache.set(repository, entries);
      } catch { cache.set(repository, null); } // unavailable observation never manufactures success
    }
    return cache.get(repository);
  };
}

export function requestedWorktree(seg) {
  if (!seg.cwd || !seg.path || !seg.branch) return null;
  try {
    const common = git(['-C', seg.cwd, 'rev-parse', '--git-common-dir']).trim();
    return { repository: physicalPath(resolve(seg.cwd, common)), branch: seg.branch,
      path: physicalPath(resolve(seg.cwd, seg.path)), requested_at: new Date().toISOString() };
  } catch { return null; }
}

export function reconcile(state, observe) {
  state.pending = state.pending.filter((pending) => {
    if (!observe(pending.repository)?.some((current) => exact(current, pending))) return true;
    if (!state.confirmed.some((r) => key(r) === key(pending))) {
      state.confirmed.push({ ...pending, confirmed_at: new Date().toISOString() });
    }
    return false;
  });
  return state;
}

export function queueRequests(state, requests, observe, requiresApproval) {
  for (const request of requests) {
    // A worktree already present BEFORE this request cannot prove this request later succeeded.
    const before = observe(request.repository);
    if (!before || before.some((current) => exact(current, request))) continue;
    if (!state.confirmed.some((r) => key(r) === key(request)) && !state.pending.some((r) => exact(r, request))) {
      state.pending.push({ ...request, requires_approval: requiresApproval });
    }
  }
}

export function unseenRequests(state, requests) {
  return requests.filter((r, i) => !state.confirmed.some((c) => key(c) === key(r)) && requests.findIndex((other) => key(other) === key(r)) === i);
}

export function saveSession(file, state) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    mkdirSync(dirname(file), { recursive: true });
    state.branches = [...new Set(state.confirmed.map((r) => r.branch))]; // compatibility view, confirmed only
    writeFileSync(temp, JSON.stringify(state) + '\n', { flag: 'wx', mode: 0o600 });
    renameSync(temp, file);
  } catch { /* preserve the existing best-effort local counter contract */ }
  finally { try { rmSync(temp, { force: true }); } catch {} }
}
