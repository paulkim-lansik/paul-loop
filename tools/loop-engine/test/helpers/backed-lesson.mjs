// Test-only authoritative issuer. It creates immutable receipt files in an explicit disposable root;
// it does not make summaries a substitute for evidence. Actual verifier issuance has separate E2E tests.
import { realpathSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { evidenceDir, writeEvidence } from '../../lib/evidence-graph.mjs';
import { lessonContentHash } from '../../lib/lesson-state.mjs';
import { sealLessonVerification } from '../../lib/lesson-evidence.mjs';
export function backedLesson(value, root) {
  if (value.verified !== true) return value;
  root = realpathSync(root);
  const hash = v => createHash('sha256').update(v).digest('hex');
  const dir = evidenceDir(root), now = Date.now();
  const base = { kind: 'verification', mode: 'gate', run_id: randomUUID(), root_hash: hash(root),
    command_hash: hash('fixture verifier'), verdict_sha256: hash('fixture verdict') };
  const fail = writeEvidence(dir, { ...base, verdict: 'FAIL', exit: 1,
    target_before: { digest: hash('broken implementation') }, target_after: { digest: hash('broken implementation') },
    started_at: new Date(now - 4).toISOString(), finished_at: new Date(now - 3).toISOString() });
  const pass = writeEvidence(dir, { ...base, verdict: 'PASS', exit: 0,
    target_before: { digest: hash('fixed implementation') }, target_after: { digest: hash('fixed implementation') },
    started_at: new Date(now - 2).toISOString(), finished_at: new Date(now - 1).toISOString() });
  const content_hash = lessonContentHash(value);
  const summary = sealLessonVerification(value, content_hash, { id: pass.id, failure_id: fail.id }, {}, root);
  return { ...value, verification: { version: 1, content_hash, receipts: [summary] } };
}
