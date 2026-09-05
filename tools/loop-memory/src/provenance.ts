import { createHmac, timingSafeEqual } from 'node:crypto';
import { sha256, type StoreContext } from './store';

/** Scope-bound write provenance for all corpora. Only possession of the signing key can authenticate
 * owner/corpus/source/model/content. This is not factual validation or adversarial attestation; see
 * HARDENING.md. Legacy content-only helpers remain exported, but recall uses verifyNote exclusively. */

/** content에 대한 HMAC-SHA256 서명(hex). content가 바뀌면 서명도 반드시 다시 계산해야 한다 —
 *  content만 바뀌고 서명이 그대로면 verifySignature가 자동으로 무효 판정한다(별도 무효화 로직 불필요). */
export function signContent(content: string, secret: string): string {
  return createHmac('sha256', secret).update(content).digest('hex');
}

/** signature가 content를 secret으로 서명한 결과와 일치하는지 상수시간 비교로 검증한다.
 *  signature가 없거나(null/undefined/빈 문자열), 길이가 안 맞거나, hex가 아니면 false(fail-closed). */
export function verifySignature(
  content: string,
  secret: string,
  signature: string | null | undefined,
): boolean {
  if (!signature || !/^[a-f0-9]{64}$/.test(signature)) return false;
  const expected = signContent(content, secret);
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(signature, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export interface NoteProvenance {
  ownerId: string; corpus: string; sourceKey: string; embeddingId: string;
  content: string; contentHash: string; provenance?: string | null;
}
const envelope = (note: NoteProvenance) => JSON.stringify([
  'loop-memory-note-v2', note.ownerId, note.corpus, note.sourceKey, note.embeddingId, note.contentHash,
]);
export function signNote(content: string, corpus: string, sourceKey: string, ctx: StoreContext): string {
  return signContent(envelope({ content, contentHash: sha256(content), corpus, sourceKey,
    ownerId: ctx.owner, embeddingId: ctx.embeddingId }), ctx.signingKey);
}
export function verifyNote(note: NoteProvenance, ctx: StoreContext): boolean {
  return note.ownerId === ctx.owner && note.embeddingId === ctx.embeddingId && !!note.sourceKey &&
    note.contentHash === sha256(note.content) &&
    verifySignature(envelope(note), ctx.signingKey, note.provenance);
}

/** `LOOP_MEMORY_SIGNING_KEY`를 process.env에서 읽는다(plugin hooks inject it from userConfig; a
 *  standalone CLI invocation reads it from the shell). 없으면 undefined — 호출부(graduateLessons/
 *  recallLessons)가 각자의 fail-closed 규칙을 적용한다(README "위협모델" 참고). */
export function signingKeyFromEnv(): string | undefined {
  return process.env.LOOP_MEMORY_SIGNING_KEY || undefined;
}
