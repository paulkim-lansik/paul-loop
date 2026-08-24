/**
 * Liveness reader (paul-loop issue #35) — folds the `memory.*` events the hooks append to
 * loop-engine's session run ledger (`.loop/runs/<run-id>.jsonl`) into a summary a health check can
 * assert on.
 *
 * The writer is `hooks/lib/liveness.mjs`; this is the only consumer that ships with the plugin. It
 * touches no database and needs no embedding key — it is pure filesystem, so a consuming repo's
 * doctor can call it unconditionally (unlike `stats`, which needs the store up).
 *
 * Why this exists rather than "grep the ledger yourself": the useful question is not "is there a
 * line" but "which of the four states is the hook in", and a consumer that has to re-derive
 * `injected` vs `no_match` vs `skipped` vs `error` from raw payloads will encode this plugin's
 * internals. A repo whose doctor currently runs a *synthetic* recall probe (embed a canned query,
 * see if anything comes back) can replace it with this and check the real hook's real firings
 * instead — a probe proves the CLI works, not that the hook ran.
 *
 * ⚠️ The ledger is gitignored, unprotected local telemetry and is forgeable by anyone with shell
 * access (same boundary as loop-engine's own run ledger). Treat what this returns as observability,
 * never as a gate input.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const RECALL_TYPE = 'memory.recall';
export const GRADUATE_TYPE = 'memory.graduate';

/** The four states fail-open otherwise flattens into one. `skipped` = the hook ran and gated itself
 *  (no key / recall off / prompt too short); `no_match` = the whole pipeline ran and the corpus had
 *  nothing close enough; `error` = it ran and something downstream broke. "Never fired" is the
 *  absence of every one of them — which is why counting zero is a meaningful answer here. */
export type Outcome = 'injected' | 'no_match' | 'skipped' | 'error';

export interface OutcomeCounts {
  total: number;
  injected: number;
  no_match: number;
  skipped: number;
  error: number;
  /** reason slug → count, e.g. `{ no_embedding_key: 42 }`. The slug is what says *why* it self-gated. */
  reasons: Record<string, number>;
  lastAt: string | null;
}

export interface LivenessSummary {
  root: string;
  /** Run files inspected (newest first, capped by `runs`). 0 = the ledger directory doesn't exist. */
  runsScanned: number;
  /** Of those, how many contain at least one recall firing — "recall fired in N of the last M runs". */
  runsWithRecall: number;
  recall: OutcomeCounts;
  graduate: OutcomeCounts;
  /** Most recent firing that actually injected context, if any. */
  lastInjectedAt: string | null;
  /** Unparseable lines skipped, so a partial read is visible instead of silently smaller. */
  skippedLines: number;
}

interface LedgerEvent {
  type?: unknown;
  ts?: unknown;
  payload?: { outcome?: unknown; reason?: unknown } | null;
}

function emptyCounts(): OutcomeCounts {
  return { total: 0, injected: 0, no_match: 0, skipped: 0, error: 0, reasons: {}, lastAt: null };
}

const OUTCOMES: readonly Outcome[] = ['injected', 'no_match', 'skipped', 'error'];

function tally(counts: OutcomeCounts, e: LedgerEvent): void {
  counts.total++;
  const outcome = e.payload?.outcome;
  if (typeof outcome === 'string' && (OUTCOMES as readonly string[]).includes(outcome)) {
    counts[outcome as Outcome]++;
  }
  const reason = e.payload?.reason;
  if (typeof reason === 'string') counts.reasons[reason] = (counts.reasons[reason] ?? 0) + 1;
  const ts = e.ts;
  // Lexicographic max works because every ts is an ISO-8601 UTC string from `toISOString()`.
  if (typeof ts === 'string' && (counts.lastAt === null || ts > counts.lastAt)) counts.lastAt = ts;
}

/**
 * Folds the newest `runs` run files under `<root>/.loop/runs/`.
 *
 * Newest-first by mtime rather than "all of them": the question a doctor asks is "has recall fired
 * *recently*", and a months-old ledger would otherwise let a hook that died last week keep reporting
 * healthy forever.
 */
export function summarizeLiveness(root: string, opts: { runs?: number } = {}): LivenessSummary {
  const limit = opts.runs && opts.runs > 0 ? opts.runs : 20;
  const dir = join(root, '.loop', 'runs');
  const summary: LivenessSummary = {
    root,
    runsScanned: 0,
    runsWithRecall: 0,
    recall: emptyCounts(),
    graduate: emptyCounts(),
    lastInjectedAt: null,
    skippedLines: 0,
  };

  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return summary; // no ledger at all — the "never fired" answer, reported as zeros not as an error
  }
  const byRecency = files
    .map((f) => {
      let mtime = 0;
      try {
        mtime = statSync(join(dir, f)).mtimeMs;
      } catch {
        /* raced away between readdir and stat — sorts last, then fails the read below harmlessly */
      }
      return { f, mtime };
    })
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit);

  for (const { f } of byRecency) {
    let raw: string;
    try {
      raw = readFileSync(join(dir, f), 'utf8');
    } catch {
      continue;
    }
    summary.runsScanned++;
    let sawRecall = false;
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let e: LedgerEvent;
      try {
        e = JSON.parse(line) as LedgerEvent;
      } catch {
        summary.skippedLines++;
        continue;
      }
      // loop-engine's own events (run.started, verdict.*, ...) share these files — skip, don't count.
      if (e?.type === RECALL_TYPE) {
        sawRecall = true;
        tally(summary.recall, e);
        if (e.payload?.outcome === 'injected' && typeof e.ts === 'string') {
          if (summary.lastInjectedAt === null || e.ts > summary.lastInjectedAt) {
            summary.lastInjectedAt = e.ts;
          }
        }
      } else if (e?.type === GRADUATE_TYPE) {
        tally(summary.graduate, e);
      }
    }
    if (sawRecall) summary.runsWithRecall++;
  }
  return summary;
}

/** Human-readable rendering, one line per fact — the shape a `loop-doctor`-style row wants. */
export function formatLiveness(s: LivenessSummary): string {
  const fmtReasons = (r: Record<string, number>) => {
    const parts = Object.entries(r)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k} ${v}`);
    return parts.length ? parts.join(' · ') : '(none)';
  };
  const line = (label: string, c: OutcomeCounts) =>
    `  ${label}: ${c.total} firing(s) — injected ${c.injected} · no_match ${c.no_match} · ` +
    `skipped ${c.skipped} · error ${c.error}\n    reasons: ${fmtReasons(c.reasons)}\n` +
    `    last: ${c.lastAt ?? '(never)'}\n`;
  return (
    'loop-memory liveness:\n' +
    `  ledger: ${join(s.root, '.loop', 'runs')} — ${s.runsScanned} run file(s) scanned` +
    `${s.skippedLines ? `, ${s.skippedLines} unparseable line(s) skipped` : ''}\n` +
    `  recall fired in ${s.runsWithRecall}/${s.runsScanned} run(s)\n` +
    line('recall', s.recall) +
    line('graduate', s.graduate) +
    `  last injected: ${s.lastInjectedAt ?? '(never)'}\n`
  );
}
