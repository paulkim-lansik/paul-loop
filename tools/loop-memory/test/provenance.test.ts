import { describe, expect, it } from 'vitest';
import { signContent, signingKeyFromEnv, verifySignature } from '../src/provenance';

// 단위 테스트(docker 불필요) — write-path provenance(BAC-619)의 순수 함수 계약.
describe('signContent / verifySignature', () => {
  it('같은 content+secret은 검증을 통과한다', () => {
    const sig = signContent('hello lesson', 'secret-a');
    expect(verifySignature('hello lesson', 'secret-a', sig)).toBe(true);
  });

  it('content가 바뀌면(서명 재계산 없이) 검증이 실패한다 — 별도 무효화 로직 없이도 fail-closed', () => {
    const sig = signContent('original content', 'secret-a');
    expect(verifySignature('tampered content', 'secret-a', sig)).toBe(false);
  });

  it('secret이 다르면 검증이 실패한다', () => {
    const sig = signContent('hello lesson', 'secret-a');
    expect(verifySignature('hello lesson', 'secret-b', sig)).toBe(false);
  });

  it('서명이 없으면(null/undefined/빈 문자열) 항상 실패한다', () => {
    expect(verifySignature('hello', 'secret-a', null)).toBe(false);
    expect(verifySignature('hello', 'secret-a', undefined)).toBe(false);
    expect(verifySignature('hello', 'secret-a', '')).toBe(false);
  });

  it('길이가 다른(자를 수 없는) 위조 서명도 실패한다', () => {
    expect(verifySignature('hello', 'secret-a', 'deadbeef')).toBe(false);
  });
});

describe('signingKeyFromEnv', () => {
  it('LOOP_MEMORY_SIGNING_KEY가 없으면 undefined', () => {
    const prev = process.env.LOOP_MEMORY_SIGNING_KEY;
    delete process.env.LOOP_MEMORY_SIGNING_KEY;
    try {
      expect(signingKeyFromEnv()).toBeUndefined();
    } finally {
      if (prev !== undefined) process.env.LOOP_MEMORY_SIGNING_KEY = prev;
    }
  });

  it('LOOP_MEMORY_SIGNING_KEY가 있으면 그 값을 반환', () => {
    const prev = process.env.LOOP_MEMORY_SIGNING_KEY;
    process.env.LOOP_MEMORY_SIGNING_KEY = 'from-env';
    try {
      expect(signingKeyFromEnv()).toBe('from-env');
    } finally {
      if (prev === undefined) delete process.env.LOOP_MEMORY_SIGNING_KEY;
      else process.env.LOOP_MEMORY_SIGNING_KEY = prev;
    }
  });
});
