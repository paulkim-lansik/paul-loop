// Reads the JSON object Claude Code pipes to a hook on stdin, best-effort.
//
// Used by hooks/recall-lessons.mjs only — that hook must read stdin regardless (the prompt is there),
// and it also takes `session_id` off it to attribute its liveness events to the same run the rest of
// the session's ledger is under (hooks/lib/liveness.mjs). hooks/graduate-lessons.mjs deliberately
// does NOT use this: see its header — a read-to-EOF on an fd 0 nobody closes hangs forever (measured),
// and a hanging SessionStart hook stalls session startup, so it takes its lifecycle name from an
// argv flag instead.
//
// The TTY guard narrows the same hazard for recall: an interactive fd 0 (a hand-run in a terminal)
// never yields EOF, so it is treated as "no input" rather than read. A *closed* or empty stdin (a
// pipe, /dev/null, CI) returns '' and lands on the same null as a parse failure — callers treat "no
// input" and "unparseable input" identically. It cannot cover an inherited pipe that stays open;
// nothing synchronous can, and Claude Code's own contract is to write the JSON and close.
import { fstatSync, readFileSync } from 'node:fs';

/** @returns {object|null} the parsed stdin object, or null if there was nothing readable/parseable. */
export function readHookInput() {
  try {
    if (fstatSync(0).isCharacterDevice()) return null; // interactive terminal (or /dev/null) — don't block
    const raw = readFileSync(0, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}
