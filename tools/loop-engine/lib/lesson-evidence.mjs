import { lstatSync, realpathSync, readFileSync } from 'node:fs';
import { basename, dirname, resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { readEvidence, writeEvidence, evidenceDir } from './evidence-graph.mjs';

const hash = x => createHash('sha256').update(x).digest('hex');
const digest = x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
export function lessonReceipt(file, verdict, root = process.cwd()) {
  if (!file) throw Error('--receipt/--failure-receipt required for verified evidence');
  const expected = evidenceDir(root);
  const abs = resolve(file);
  if (lstatSync(abs).isSymbolicLink() || !lstatSync(abs).isFile() ||
      realpathSync(dirname(abs)) !== realpathSync(expected)) throw Error('receipt outside local evidence directory');
  const id = basename(abs, '.json');
  if (basename(abs) !== `${id}.json`) throw Error('receipt extension invalid');
  const r = readEvidence(expected, id);
  if (r.kind !== 'verification' || r.verdict !== verdict || !Number.isInteger(r.exit) ||
      (verdict === 'PASS' ? r.exit !== 0 : r.exit === 0) ||
      r.mode && r.mode !== 'gate' || r.root_hash !== hash(realpathSync(root)) ||
      !digest(r.command_hash) || !digest(r.verdict_sha256) ||
      !digest(r.target_before?.digest) || r.target_before.digest !== r.target_after?.digest ||
      typeof r.run_id !== 'string' || !r.run_id ||
      !Number.isFinite(Date.parse(r.started_at)) || !Number.isFinite(Date.parse(r.finished_at)) ||
      Date.parse(r.finished_at) < Date.parse(r.started_at)) throw Error('receipt does not prove stable local verification');
  return r;
}
export function lessonVerification(passFile, failFile, signatureFile, root = process.cwd()) {
  const pass = lessonReceipt(passFile, 'PASS', root);
  const fail = lessonReceipt(failFile, 'FAIL', root);
  if (fail.verdict_sha256 !== hash(readFileSync(signatureFile))) throw Error('receipt pair is not a matching FAIL-to-PASS verification');
  return pairSummary(pass, fail);
}
function pairSummary(pass, fail) {
  if (fail.target_after.digest === pass.target_before.digest || pass.id === fail.id || pass.run_id !== fail.run_id || pass.command_hash !== fail.command_hash ||
      Date.parse(fail.finished_at) > Date.parse(pass.started_at)) throw Error('receipt pair is not a matching FAIL-to-PASS verification');
  return { id: pass.id, failure_id: fail.id, run_id: pass.run_id, verdict: 'PASS',
    command_hash: pass.command_hash, root_hash: pass.root_hash, finished_at: pass.finished_at,
    fix_target_before: fail.target_after.digest, fix_target_after: pass.target_before.digest };
}

function localFile(id, root) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw Error('invalid lesson evidence id');
  return join(evidenceDir(root), `${id}.json`);
}
function backedSummary(summary, root) {
  return pairSummary(lessonReceipt(localFile(summary.id, root), 'PASS', root),
    lessonReceipt(localFile(summary.failure_id, root), 'FAIL', root));
}
/** Immutable producer record binds the admitted lesson text to real local verification receipts.
 * Its checksum is not an attestation against unrestricted filesystem/command authority. */
export function sealLessonVerification(lesson, contentHash, evidence, metadata = {}, root = process.cwd()) {
  if (process.env.LOOP_LEARNING_OFF === '1') throw Error('learning_off');
  const summary = { ...backedSummary(evidence, root), ...metadata };
  // Metadata can describe the gate/iteration count, never replace receipt-derived identity.
  for (const key of Object.keys(metadata)) if (!['gate', 'iterations'].includes(key)) throw Error('invalid lesson metadata');
  const seal = writeEvidence(evidenceDir(root), { kind: 'knowledge', purpose: 'lesson-verification',
    lesson_id: lesson.id, lesson_content_hash: contentHash, root_hash: hash(realpathSync(root)), summary });
  return { ...summary, seal_id: seal.id };
}
export function verifiedLessonSummary(lesson, contentHash, candidate, root = process.cwd()) {
  const file = localFile(candidate.seal_id, root);
  if (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()) throw Error('invalid lesson seal file');
  const seal = readEvidence(evidenceDir(root), candidate.seal_id);
  if (seal.kind !== 'knowledge' || seal.purpose !== 'lesson-verification' ||
      seal.lesson_id !== lesson.id || seal.lesson_content_hash !== contentHash ||
      seal.root_hash !== hash(realpathSync(root))) throw Error('lesson seal content/workspace mismatch');
  const backing = backedSummary(seal.summary, root);
  for (const [key, value] of Object.entries(backing)) if (seal.summary[key] !== value) throw Error('lesson backing mismatch');
  const expected = { ...seal.summary, seal_id: seal.id };
  if (Object.keys(candidate).length !== Object.keys(expected).length ||
      Object.entries(expected).some(([key, value]) => candidate[key] !== value)) throw Error('lesson summary differs from producer seal');
  return expected;
}
