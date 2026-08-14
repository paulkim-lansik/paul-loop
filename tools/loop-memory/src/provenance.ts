import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * write-path provenance 방어 (BAC-619).
 *
 * SMSR 논문(arXiv:2606.12703)이 무방어 persistent 메모리 에이전트의 메모리 포이즈닝 공격성공률
 * (ASR) 93~100%를 실측했다 — 자세한 위협모델·설계 근거는 README.md "위협모델" 절 참고.
 *
 * lesson 노트는 `graduateLessons`(lessons.ts)가 `readVerifiedLessons`(retrospect --verified 경유로
 * 기록된 것만)를 pgvector로 졸업시킬 때만 이 HMAC으로 서명한다. secret(`LOOP_MEMORY_SIGNING_KEY` —
 * plugin userConfig(sensitive)/Keychain, or plain env var for standalone CLI use)을 모르는 쓰기
 * 경로(직접 SQL INSERT, 다른 코드 경로에서의 addNote 호출 등)는 유효한 서명을 만들 수 없다 —
 * `recallLessons`가 서명 없음/불일치 노트를 injection 후보에서 제외해(fail-closed) 구조적으로 걸러낸다.
 */

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
  if (!signature) return false;
  const expected = signContent(content, secret);
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(signature, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** `LOOP_MEMORY_SIGNING_KEY`를 process.env에서 읽는다(plugin hooks inject it from userConfig; a
 *  standalone CLI invocation reads it from the shell). 없으면 undefined — 호출부(graduateLessons/
 *  recallLessons)가 각자의 fail-closed 규칙을 적용한다(README "위협모델" 참고). */
export function signingKeyFromEnv(): string | undefined {
  return process.env.LOOP_MEMORY_SIGNING_KEY || undefined;
}
