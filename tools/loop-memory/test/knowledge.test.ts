import { describe, expect, it } from 'vitest';
import { parseAdrChunks, parseContextChunks, parseMarkdownChunks } from '../src/knowledge';

// 합성 ADR — 표준 헤딩 + `###` 하위섹션(부모 `##`에 흡수돼야) + 서두(청킹 제외).
const SAMPLE_ADR = `# ADR-0099: 테스트 결정

- **상태**: accepted (2026-01-01)
- **날짜**: 2026-01-01

## 컨텍스트

배경 텍스트 컨텍스트.

## 결정

우리는 X를 한다.

### 세부

하위 섹션은 부모 결정에 포함된다.

## 결과 (트레이드오프)

좋은 점과 나쁜 점.
`;

describe('parseAdrChunks — 섹션 청킹', () => {
  it('ADR을 ## 섹션 단위로 청킹한다 (### 하위섹션은 부모에 흡수, 서두 제외)', () => {
    const chunks = parseAdrChunks(SAMPLE_ADR, '0099');

    // 3개 ## 섹션만 (서두=상태/날짜는 청크 아님).
    expect(chunks.map((c) => c.key)).toEqual([
      'kb:adr:0099#컨텍스트',
      'kb:adr:0099#결정',
      'kb:adr:0099#결과 (트레이드오프)',
    ]);

    // 태그는 전부 kb:adr.
    expect(chunks.every((c) => c.tag === 'kb:adr')).toBe(true);

    // ### 하위섹션 본문은 부모 ## 결정 청크에 들어간다.
    const decision = chunks.find((c) => c.key === 'kb:adr:0099#결정');
    expect(decision).toBeDefined();
    expect(decision?.content).toContain('우리는 X를 한다');
    expect(decision?.content).toContain('하위 섹션은 부모 결정에 포함된다');

    // context에 ADR 번호와 제목이 담겨 recall 가독성을 준다.
    expect(decision?.context).toContain('ADR-0099');
    expect(decision?.context).toContain('테스트 결정');

    // hash는 8자리 hex.
    expect(decision?.hash).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('parseAdrChunks — 폐기 제외', () => {
  it('상태가 폐기됨이면 [] (인덱싱 제외)', () => {
    const superseded = SAMPLE_ADR.replace(
      '- **상태**: accepted (2026-01-01)',
      '- **상태**: **폐기됨** (ADR-0100으로 대체)',
    );
    expect(parseAdrChunks(superseded, '0099')).toEqual([]);
  });

  it('상태가 superseded/deprecated여도 [] (대소문자 무관)', () => {
    const dep = SAMPLE_ADR.replace('- **상태**: accepted (2026-01-01)', '- **상태**: Deprecated');
    expect(parseAdrChunks(dep, '0099')).toEqual([]);
  });

  it('상태 지정자가 대체됨이면 [] (0000-template 지정자)', () => {
    const replaced = SAMPLE_ADR.replace(
      '- **상태**: accepted (2026-01-01)',
      '- **상태**: 대체됨 (ADR-0100)',
    );
    expect(parseAdrChunks(replaced, '0099')).toEqual([]);
  });

  it('지정자가 accepted면 주석에 "폐기된 ADR-XXXX" 언급이 있어도 인덱싱한다 (실 ADR-0033 shape 오탐 방지)', () => {
    const acceptedWithMention = SAMPLE_ADR.replace(
      '- **상태**: accepted (2026-01-01)',
      '- **상태**: accepted (2026-01-01) — 폐기된 ADR-0021(제품 5층 메모리)의 실현 가능한 후계',
    );
    expect(parseAdrChunks(acceptedWithMention, '0099')).toHaveLength(3);
  });
});

describe('parseAdrChunks — 중복 헤딩 키 유일화', () => {
  it('같은 ADR 안 중복 ## 헤딩은 카운터 접미로 유일한 키를 만든다 (미러-싱크 수렴성)', () => {
    const dup =
      '# ADR-0099: 중복\n\n- **상태**: accepted\n\n## 참고\n\n첫째.\n\n## 참고\n\n둘째.\n';
    const keys = parseAdrChunks(dup, '0099').map((c) => c.key);
    expect(keys).toEqual(['kb:adr:0099#참고', 'kb:adr:0099#참고 (2)']);
    expect(new Set(keys).size).toBe(keys.length); // 전부 유일
  });
});

describe('parseAdrChunks — hash 안정성/민감성 (미러-싱크 급소)', () => {
  it('같은 content = 같은 hash, 한 섹션 편집 = 그 섹션 hash만 변경', () => {
    const a = parseAdrChunks(SAMPLE_ADR, '0099');
    const b = parseAdrChunks(SAMPLE_ADR, '0099');
    // 같은 입력 → 같은 hash (재실행 NOOP의 근거).
    for (let i = 0; i < a.length; i++) expect(a[i]?.hash).toBe(b[i]?.hash);

    // 결정 섹션 본문만 편집.
    const edited = parseAdrChunks(SAMPLE_ADR.replace('우리는 X를 한다', '우리는 Y를 한다'), '0099');
    const key = (cs: typeof a, k: string) => cs.find((c) => c.key === k)?.hash;
    // 편집된 섹션 hash는 변한다.
    expect(key(edited, 'kb:adr:0099#결정')).not.toBe(key(a, 'kb:adr:0099#결정'));
    // 손대지 않은 섹션 hash는 그대로 (한 섹션만 UPDATE의 근거).
    expect(key(edited, 'kb:adr:0099#컨텍스트')).toBe(key(a, 'kb:adr:0099#컨텍스트'));
  });
});

// BAC-355: research/design 공용 파서 — parseAdrChunks와 같은 ##-섹션 알고리즘이지만 상태체크 없음.
const SAMPLE_RESEARCH = `# 루프 엔지니어링 — 성숙도 재평가 (2026-06-30)

한 줄 결론이 여기 온다(청크 아님 — 서두).

## 1. 세 축의 성숙도

내용 1.

## 2. 차원별 스코어카드

내용 2.

### 2.1 세부

하위 섹션은 부모에 흡수된다.
`;

describe('parseMarkdownChunks — research/design 공용 ##-섹션 청킹', () => {
  it('H1 제목을 provenance로, ## 섹션 단위로 청킹한다 (### 하위섹션은 부모에 흡수, 서두 제외)', () => {
    const chunks = parseMarkdownChunks(
      SAMPLE_RESEARCH,
      'kb:research',
      '2026-06-30-loop-maturity-reassessment',
      'docs/research/2026-06-30-loop-maturity-reassessment.md',
    );
    expect(chunks.map((c) => c.key)).toEqual([
      'kb:research:2026-06-30-loop-maturity-reassessment#1. 세 축의 성숙도',
      'kb:research:2026-06-30-loop-maturity-reassessment#2. 차원별 스코어카드',
    ]);
    expect(chunks.every((c) => c.tag === 'kb:research')).toBe(true);
    const second = chunks.find((c) => c.key.endsWith('#2. 차원별 스코어카드'));
    expect(second?.content).toContain('내용 2');
    expect(second?.content).toContain('하위 섹션은 부모에 흡수된다');
    expect(second?.context).toContain('루프 엔지니어링 — 성숙도 재평가');
  });

  it('제목(H1)이 없으면 docId를 provenance로 대체한다', () => {
    const noTitle = '## 섹션\n\n본문.\n';
    const chunks = parseMarkdownChunks(
      noTitle,
      'kb:design',
      'untitled-doc',
      'docs/product/design/x.md',
    );
    expect(chunks[0]?.context).toContain('untitled-doc');
  });

  it('같은 문서 안 중복 ## 헤딩은 카운터 접미로 유일화된다', () => {
    const dup = '# 문서\n\n## 참고\n\n첫째.\n\n## 참고\n\n둘째.\n';
    const keys = parseMarkdownChunks(dup, 'kb:research', 'dup-doc', 'docs/research/dup.md').map(
      (c) => c.key,
    );
    expect(keys).toEqual(['kb:research:dup-doc#참고', 'kb:research:dup-doc#참고 (2)']);
  });
});

// BAC-355: CONTEXT.md 용어-단위 청킹 — 섹션 전체가 아니라 개별 **용어**: 단락이 청크.
const SAMPLE_CONTEXT = `# glucofit-partners

이 서두 프로즈는 어느 용어에도 안 속해 제외된다.

## Framework — dev harness (하네스)

**Framework** (하네스 / Harness):
루프 엔지니어링 레이어.

**Verifier** (검증기):
그라운드트루스 신호.

## Product — hospital SaaS (병원 도메인)

**병원 / Hospital**:
테넌트 하나.

### 검진·진료톡 도메인 (M1 파일럿)

**소견 / Finding**:
룰기반 해석.
`;

describe('parseContextChunks — CONTEXT.md 용어 단위 청킹', () => {
  it('##/### 헤딩을 계층 라벨로, 그 안의 **용어**: 단락을 개별 청크로 만든다', () => {
    const chunks = parseContextChunks(SAMPLE_CONTEXT);
    expect(chunks.map((c) => c.key)).toEqual([
      'kb:context:Framework — dev harness (하네스):Framework',
      'kb:context:Framework — dev harness (하네스):Verifier',
      'kb:context:Product — hospital SaaS (병원 도메인):병원 / Hospital',
      'kb:context:검진·진료톡 도메인 (M1 파일럿):소견 / Finding',
    ]);
    expect(chunks.every((c) => c.tag === 'kb:context')).toBe(true);
    // 서두 프로즈("이 서두 프로즈는...")는 어느 청크에도 안 들어간다.
    expect(chunks.some((c) => c.content.includes('서두 프로즈'))).toBe(false);
  });

  it('각 용어 청크는 자기 정의만 담고 옆 용어 내용과 안 섞인다 (개별 recall의 전제)', () => {
    const chunks = parseContextChunks(SAMPLE_CONTEXT);
    const verifier = chunks.find((c) => c.key.endsWith(':Verifier'));
    expect(verifier?.content).toContain('그라운드트루스 신호');
    expect(verifier?.content).not.toContain('루프 엔지니어링 레이어'); // Framework 정의는 안 섞임
  });

  it('같은 헤딩 안 중복 용어명은 카운터 접미로 유일화된다', () => {
    const dup = '## 섹션\n\n**용어**:\n첫째.\n\n**용어**:\n둘째.\n';
    const keys = parseContextChunks(dup).map((c) => c.key);
    expect(keys).toEqual(['kb:context:섹션:용어', 'kb:context:섹션:용어 (2)']);
  });

  it('헤딩 밖(문서 최상단 H1 이전) 용어처럼 보이는 줄은 무시한다 (section=null 가드)', () => {
    const noSection = '**용어**:\n헤딩 없이 등장.\n';
    expect(parseContextChunks(noSection)).toEqual([]);
  });
});
