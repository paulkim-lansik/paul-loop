import { createHash } from 'node:crypto';
import { verifiedLessonSummary } from './lesson-evidence.mjs';

export function lessonContentHash(l) {
  return createHash('sha256').update(JSON.stringify([
    typeof l.title === 'string' ? l.title : '', typeof l.fix === 'string' ? l.fix : '',
    Array.isArray(l.signature) ? l.signature.filter(s => typeof s === 'string') : [],
  ])).digest('hex');
}
/** Shared state contract. Legacy verified flags are historical claims, not verified receipts. */
export function lessonState(l, { root = process.cwd() } = {}) {
  const receipts = Array.isArray(l.verification?.receipts) ? l.verification.receipts : [];
  const contentHash = lessonContentHash(l);
  const valid = [];
  if (l.verified === true && l.verification?.version === 1 && l.verification.content_hash === contentHash) {
    for (const candidate of receipts) {
      try { valid.push(verifiedLessonSummary(l, contentHash, candidate, root)); }
      catch { /* Missing, fabricated, changed or foreign evidence is never a verified history. */ }
    }
  }
  const unique = [...new Map(valid.map(r => [r.run_id, r])).values()];
  return {
    invalidated: typeof l.invalid_at === 'string' && !!l.invalid_at,
    rejected: l.challenge?.verdict === 'reject',
    retired: typeof l.retired?.at === 'string' && !!l.retired.at,
    verified: l.verified === true && l.verification?.version === 1 &&
      l.verification.content_hash === lessonContentHash(l) && unique.length > 0,
    receipts: unique,
  };
}
