import { backedLesson } from '../../loop-engine/test/helpers/backed-lesson.mjs';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  decideLessonReap,
  lessonStub,
  readLessonRecords as readRecords,
  readVerifiedLessons as readVerified,
} from '../src/lessons';

// 순수 로직 단위 테스트(DB 불필요) — BAC-580: 승격 게이트(retired/challenge.verdict=reject)가
// readVerifiedLessons(ADD 필터)와 decideLessonReap(이미 졸업된 노트의 회수 결정) 양쪽에서 실제로
// 지켜지는지 증명한다.

let dir: string;
const readLessonRecords = (root: string) => readRecords(root, { root });
const readVerifiedLessons = (root: string) => readVerified(root, { root });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'loop-lessons-unit-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(id: string, patch: Record<string, unknown>) {
  const l = { id, verified: true, ...patch };
  writeFileSync(join(dir, `${id}.json`), JSON.stringify(backedLesson(l, dir)));
}

describe('readVerifiedLessons — ADD 대상 필터(BAC-580)', () => {
  it('verified=true·retired 없음·challenge.verdict!=reject인 교훈만 반환한다', () => {
    write('active', { title: '활성 교훈' });
    write('unverified', { verified: false, title: '미검증' });
    write('retired', {
      title: '퇴역됨',
      retired: { at: '2026-08-01T00:00:00.000Z', ref: 'CLAUDE.md §8', by: 'test' },
    });
    write('rejected', { title: '기각됨', challenge: { verdict: 'reject' } });
    write('accepted-not-retired', {
      title: '수락됐지만 아직 퇴역 전',
      challenge: { verdict: 'accept' },
    });

    const ids = readVerifiedLessons(dir)
      .map((l) => l.id)
      .sort();
    expect(ids).toEqual(['accepted-not-retired', 'active']);
  });

  it('retired 필드가 손상돼 있으면(.at 없음/빈 문자열) 퇴역으로 치지 않는다 — lessons.mjs의 fail-closed coerce와 동일', () => {
    write('malformed-retired', { title: '손상된 퇴역 필드', retired: { ref: 'CLAUDE.md §8' } }); // .at 없음
    write('empty-at', { title: '빈 at', retired: { at: '', ref: 'x' } });

    const ids = readVerifiedLessons(dir)
      .map((l) => l.id)
      .sort();
    expect(ids).toEqual(['empty-at', 'malformed-retired']); // 둘 다 여전히 ADD 대상(퇴역 아님)
  });

  it('손상된 JSON 파일은 조용히 건너뛴다', () => {
    writeFileSync(join(dir, 'corrupt.json'), '{ not valid json');
    write('ok', { title: '정상' });
    expect(readVerifiedLessons(dir).map((l) => l.id)).toEqual(['ok']);
  });
});

describe('readLessonRecords — retiredRef 추출', () => {
  it('retired.ref를 그대로 보존하고, ref가 없으면 빈 문자열', () => {
    write('with-ref', {
      retired: { at: '2026-08-01T00:00:00.000Z', ref: 'CLAUDE.md §8', by: 'x' },
    });
    write('no-ref', { retired: { at: '2026-08-01T00:00:00.000Z', ref: '', by: 'x' } });

    const byId = new Map(readLessonRecords(dir).map((l) => [l.id, l]));
    expect(byId.get('with-ref')?.retiredRef).toBe('CLAUDE.md §8');
    expect(byId.get('no-ref')?.retiredRef).toBe('');
  });
});

describe('readLessonRecords — count/lastSeen 파싱(decay 랭킹용, lessons.mjs top-level 필드와 동일 coerce)', () => {
  it('lessons.mjs가 쓰는 top-level count/last_seen을 그대로 읽는다', () => {
    write('with-decay-meta', { count: 7, last_seen: '2026-08-01T00:00:00.000Z' });
    const rec = readLessonRecords(dir)[0];
    expect(rec?.count).toBe(7);
    expect(rec?.lastSeen).toBe('2026-08-01T00:00:00.000Z');
  });

  it('필드가 없으면 count=0·lastSeen=""(정보 없음 = decay 페널티 없음의 기본값)', () => {
    write('no-decay-meta', {});
    const rec = readLessonRecords(dir)[0];
    expect(rec?.count).toBe(0);
    expect(rec?.lastSeen).toBe('');
  });

  it('count가 정수가 아니거나 음수면 0으로 fail-closed 처리(lessons.mjs coerce와 동일 방향)', () => {
    write('bad-count-negative', { count: -3 });
    write('bad-count-float', { count: 1.5 });
    write('bad-count-string', { count: 'not-a-number' });
    const byId = new Map(readLessonRecords(dir).map((l) => [l.id, l]));
    expect(byId.get('bad-count-negative')?.count).toBe(0);
    expect(byId.get('bad-count-float')?.count).toBe(0);
    expect(byId.get('bad-count-string')?.count).toBe(0);
  });

  it('last_seen이 문자열이 아니면 빈 문자열로 fail-closed 처리', () => {
    write('bad-last-seen', { last_seen: 12345 });
    const rec = readLessonRecords(dir)[0];
    expect(rec?.lastSeen).toBe('');
  });
});

describe('decideLessonReap — 순수 미러-싱크 결정(BAC-580)', () => {
  it('rec이 undefined면(이 호출이 그 파일을 못 봄) 항상 keep — 부분/빈 디렉터리 호출이 무관한 노트를 지우지 않는다', () => {
    expect(decideLessonReap('아무 내용', undefined)).toEqual({ op: 'keep' });
  });

  it('여전히 활성(verified, not retired, not rejected)이면 keep', () => {
    write('active', { title: '활성' });
    const rec = readLessonRecords(dir)[0];
    expect(rec).toBeDefined();
    expect(decideLessonReap('아무 내용', rec)).toEqual({ op: 'keep' });
  });

  it('retired면 stub — 현재 콘텐츠가 스텁과 다르면 stub op, 이미 스텁이면 keep(멱등)', () => {
    write('retired-a', {
      title: '퇴역된 교훈',
      retired: { at: '2026-08-01T00:00:00.000Z', ref: 'CLAUDE.md §8', by: 'x' },
    });
    const rec = readLessonRecords(dir)[0];
    expect(rec).toBeDefined();
    if (!rec) return;

    const decision = decideLessonReap('원래 fix 본문 그대로', rec);
    expect(decision.op).toBe('stub');
    if (decision.op !== 'stub') return;
    expect(decision.content).toBe(lessonStub(rec, 'CLAUDE.md §8'));

    // 이미 그 스텁 콘텐츠라면 재-UPDATE하지 않는다(멱등).
    expect(decideLessonReap(decision.content, rec)).toEqual({ op: 'keep' });
  });

  it('challenge.verdict=reject면 purge — 코디파이 위치가 없으므로 스텁 없이 완전 회수', () => {
    write('rejected-a', {
      title: '기각된 교훈',
      challenge: { verdict: 'reject', reason: 'flaky' },
    });
    const rec = readLessonRecords(dir)[0];
    expect(rec).toBeDefined();
    expect(decideLessonReap('원래 내용', rec)).toEqual({
      op: 'purge',
      reason: 'challenge verdict=reject',
    });
  });
});

describe('lessonStub — 대체 콘텐츠', () => {
  it('원문 대신 코디파이 위치를 가리키는 짧은 포인터를 낸다', () => {
    const s = lessonStub({ id: 'abc123', title: '퇴역된 교훈' }, 'CLAUDE.md §8');
    expect(s).toContain('CLAUDE.md §8');
    expect(s).toContain('퇴역된 교훈');
    expect(s).toContain('abc123');
  });

  it('ref가 빈 문자열이면 위치 미기록 표시로 대체', () => {
    const s = lessonStub({ id: 'abc123', title: '퇴역된 교훈' }, '');
    expect(s).toContain('위치 미기록');
  });
});
