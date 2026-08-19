import { describe, expect, it } from 'vitest';
import { clusterBySimilarity, decayedScore, type LessonEmbeddingRow } from '../src/lessons';

// 순수 로직 단위 테스트(DB 불필요) — sleep-time consolidation(BAC/paul-loop #12)의 핵심 결정 함수 둘:
// clusterBySimilarity(dedup #1·pre-scoring #3가 공유하는 클러스터링)와 decayedScore(decay 랭킹 #2).

const DIM = 8; // 테스트 전용 저차원 — 실제 컬럼은 384지만 코사인 거리 공식은 차원 무관.

function basis(idx: number): number[] {
  const v = new Array(DIM).fill(0);
  v[idx] = 1;
  return v;
}

/** idxA·idxB 두 축의 선형결합으로 idxA축과 코사인 유사도가 정확히 cosTheta인 단위벡터를 만든다.
 *  distance(결과, basis(idxA)) === 1 - cosTheta 가 정확히 보장된다. */
function mix(idxA: number, idxB: number, cosTheta: number): number[] {
  const v = new Array(DIM).fill(0);
  v[idxA] = cosTheta;
  v[idxB] = Math.sqrt(1 - cosTheta * cosTheta);
  return v;
}

/** e0-e1 평면 위 각도 deg(도)의 단위벡터 — 같은 평면 위 여러 점을 각도 차이로 정확히 통제하려고
 *  (mix는 기준축이 매번 달라져 "연쇄 근접" 같은 상대거리 시나리오를 만들기 어렵다). */
function angleVec(deg: number): number[] {
  const rad = (deg * Math.PI) / 180;
  const v = new Array(DIM).fill(0);
  v[0] = Math.cos(rad);
  v[1] = Math.sin(rad);
  return v;
}

function row(noteId: string, lessonId: string, embedding: number[]): LessonEmbeddingRow {
  return { noteId, lessonId, embedding };
}

describe('clusterBySimilarity — dedup(#1)·pre-scoring(#3)이 공유하는 순수 클러스터링', () => {
  it('빈 입력·단일 입력은 클러스터가 없다(신호 없음)', () => {
    expect(clusterBySimilarity([], 0.05)).toEqual([]);
    expect(clusterBySimilarity([row('n1', 'l1', basis(0))], 0.05)).toEqual([]);
  });

  it('임베딩이 완전히 같은(distance=0) 두 노트는 서로 다른 lesson id여도 한 클러스터로 묶인다', () => {
    const rows = [row('n1', 'lesson-a', basis(0)), row('n2', 'lesson-b', basis(0))];
    const clusters = clusterBySimilarity(rows, 0.05);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.noteIds.sort()).toEqual(['n1', 'n2']);
    expect(clusters[0]?.lessonIds.sort()).toEqual(['lesson-a', 'lesson-b']);
  });

  it('threshold 밖(멀리 있는) 노트는 클러스터에서 제외된다 — 자기 혼자면 결과에 안 남는다', () => {
    const rows = [
      row('n1', 'lesson-a', basis(0)),
      row('n2', 'lesson-b', basis(0)),
      row('n3', 'lesson-c', basis(1)), // 직교 — distance 1, 완전히 무관
    ];
    const clusters = clusterBySimilarity(rows, 0.05);
    expect(clusters).toHaveLength(1);
    expect(clusters.flatMap((c) => c.lessonIds)).not.toContain('lesson-c');
  });

  it('거리가 정확히 threshold와 같으면 포함하지 않는다(엄격 부등호, 경계 명확)', () => {
    const rows = [row('n1', 'lesson-a', basis(0)), row('n2', 'lesson-b', mix(0, 1, 0.95))]; // distance = 0.05
    expect(clusterBySimilarity(rows, 0.05)).toEqual([]); // 0.05 < 0.05는 거짓
    expect(clusterBySimilarity(rows, 0.05 + 1e-9)).toHaveLength(1); // 아주 살짝 넓히면 포함
  });

  it('느슨한 threshold(pre-scoring 용)는 dedup에서 놓치는 "비슷하지만 동일하지 않은" 쌍도 묶는다', () => {
    const rows = [row('n1', 'lesson-a', basis(0)), row('n2', 'lesson-b', mix(0, 1, 0.9))]; // distance = 0.1
    expect(clusterBySimilarity(rows, 0.05)).toEqual([]); // dedup 문턱(0.05)엔 안 걸림
    const loose = clusterBySimilarity(rows, 0.2); // pre-scoring 문턱(느슨)엔 걸림
    expect(loose).toHaveLength(1);
    expect(loose[0]?.lessonIds.sort()).toEqual(['lesson-a', 'lesson-b']);
  });

  it('연쇄 근접(A~B, B~C 하지만 A~C는 멀다)도 전이적으로 한 클러스터로 묶인다', () => {
    // 같은 평면 위 0°/15°/30° — 인접 각도 쌍(A-B, B-C)만 threshold 안, 양끝(A-C)은 밖.
    const a = angleVec(0);
    const b = angleVec(15); // distance(A,B) = 1 - cos15° ≈ 0.034
    const c = angleVec(30); // distance(B,C) ≈ 0.034, distance(A,C) = 1 - cos30° ≈ 0.134(문턱 밖)
    const rows = [row('n1', 'lesson-a', a), row('n2', 'lesson-b', b), row('n3', 'lesson-c', c)];
    const clusters = clusterBySimilarity(rows, 0.06);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.lessonIds.sort()).toEqual(['lesson-a', 'lesson-b', 'lesson-c']);
  });

  it('서로 무관한 두 쌍은 별개 클러스터 둘로 나뉜다', () => {
    const rows = [
      row('n1', 'lesson-a', basis(0)),
      row('n2', 'lesson-b', basis(0)),
      row('n3', 'lesson-c', basis(2)),
      row('n4', 'lesson-d', basis(2)),
    ];
    const clusters = clusterBySimilarity(rows, 0.05);
    expect(clusters).toHaveLength(2);
    const bylessonIds = clusters.map((c) => c.lessonIds.sort()).sort();
    expect(bylessonIds).toEqual([
      ['lesson-a', 'lesson-b'],
      ['lesson-c', 'lesson-d'],
    ]);
  });
});

describe('decayedScore — decay 랭킹(#2) 순수 스코어링', () => {
  const now = new Date('2026-08-19T00:00:00.000Z');

  it('lastSeen이 지금이면(age≈0) 페널티가 없다 — score ≈ distance', () => {
    const score = decayedScore({ distance: 0.3, lastSeen: now.toISOString(), count: 0 }, now, 30);
    expect(score).toBeCloseTo(0.3, 6);
  });

  it('lastSeen이 빈 문자열(정보 없음)이면 age=0으로 취급 — 페널티 없이 정확히 distance와 같다', () => {
    const score = decayedScore({ distance: 0.42, lastSeen: '', count: 0 }, now, 30);
    expect(score).toBe(0.42);
  });

  it('lastSeen이 파싱 불가(손상된 문자열)면 age=0으로 취급 — 페널티 없음(fail-open)', () => {
    const score = decayedScore({ distance: 0.42, lastSeen: 'not-a-date', count: 0 }, now, 30);
    expect(score).toBe(0.42);
  });

  it('반감기(halfLifeDays)만큼 지나면 count=0일 때 거리가 정확히 2배가 된다', () => {
    const halfLifeDays = 30;
    const lastSeen = new Date(now.getTime() - halfLifeDays * 86_400_000).toISOString();
    const score = decayedScore({ distance: 0.1, lastSeen, count: 0 }, now, halfLifeDays);
    expect(score).toBeCloseTo(0.2, 6);
  });

  it('count가 높을수록(자주 재발) 같은 age라도 감쇠가 완만하다 — 반감기가 늘어난다', () => {
    const halfLifeDays = 30;
    const lastSeen = new Date(now.getTime() - halfLifeDays * 86_400_000).toISOString();
    const low = decayedScore({ distance: 0.1, lastSeen, count: 0 }, now, halfLifeDays);
    const high = decayedScore({ distance: 0.1, lastSeen, count: 9 }, now, halfLifeDays); // effectiveHalfLife = 300일
    expect(high).toBeLessThan(low);
    expect(high).toBeGreaterThan(0.1); // 그래도 여전히 raw distance보단 약간 페널티가 있다(30일 지남)
  });

  it('오래될수록 단조 증가(안 좋아짐)한다 — 랭킹에서 계속 밀려난다', () => {
    const mk = (days: number) =>
      decayedScore(
        { distance: 0.1, lastSeen: new Date(now.getTime() - days * 86_400_000).toISOString(), count: 0 },
        now,
        30,
      );
    expect(mk(0)).toBeLessThan(mk(10));
    expect(mk(10)).toBeLessThan(mk(30));
    expect(mk(30)).toBeLessThan(mk(90));
  });
});
