# ADR-0001: 그래프 메모리 레이어 도입 보류

**상태**: accepted

## 컨텍스트

loop-memory(dev 루프 메모리, pgvector 기반 의미검색)는 origin 모노레포(glucofit-partners) 시절
ADR-0021/0023에서 이미 "mem0/A-MEM 직접 의존"(Python 코어, 외부 그래프 스토어 포함)을 기각하고
pgvector+Drizzle 재구현으로 결정했다. 다만 그 결정이 "그래프 관계(멀티홉 탐색)를 아예 다루지 않는다"는
뜻인지, "지금은 안 하지만 나중에 할 수 있다"는 뜻인지가 전용 문서로 남지 않았다. `memory_note.links:
uuid[]` 필드가 이미 스키마에 있지만("A-MEM의 링크 진화... 자리만, 자동 링크생성은 후속") 실제로 채우거나
조회하는 로직은 없다.

## 결정

**외부 그래프 스토어(Mem0의 Neo4j 등)는 도입하지 않는다.** 현재 `memory_note` 스키마의 `links: uuid[]`
필드(및 Postgres `WITH RECURSIVE`로 조회 가능한 관계형 경로)가 "1단계 경량 edge 경로"다 — 노트 간 관계가
필요해지면 먼저 이 필드를 실제로 채우고 재귀 CTE로 멀티홉을 흉내내는 것부터 시도하고, 그것으로 부족함이
실증된 뒤에만 전용 그래프 DB를 재검토한다.

이 결정을 기각이 아니라 "보류"로 명문화하는 이유: 아래 3개 트리거 중 하나라도 발동하면 재검토 대상이지,
영구 기각이 아니다.

## 재검토 트리거 (3종)

1. **멀티홉 질의 실패** — "N을 인용한 lesson들이 참조하는 ADR들"류의 2+ hop 질의가 실제로 필요해졌는데,
   경량 edge 경로(재귀 CTE)로 감당 안 되는 성능/복잡도가 실증될 때.
2. **ADR supersede 추적 수요** — ADR이 다른 ADR을 supersede하는 체인이 늘어나 단순 문자열 참조
   (`관련: ADR-NNNN`)로는 추적이 안 되고, 그래프 순회가 실제로 필요해질 때.
3. **코퍼스 10배 성장** — 현재 `memory_note` 규모 대비 10배 이상 증가해 flat 벡터 top-k만으로는 관련성
   랭킹이 눈에 띄게 나빠질 때.

## 고려했으나 기각한 대안

- **Mem0/A-MEM 직접 의존(외부 그래프 스토어 포함)** — ADR-0023(glucofit-partners)에서 이미 기각: Python
  코어라 순수 TS 하네스에 사이드카/외부 cloud가 필요해짐. 이 ADR은 그 기각을 loop-memory가 이관된 이
  저장소 안에서 재확인한다.
- **지금 바로 전용 그래프 DB(Neo4j 등) 도입** — 위 3 트리거 중 실증된 것이 아직 없어 과설계.

## 참고

- glucofit-partners ADR-0021(폐기됨, 5층 메모리 최초 제안), ADR-0023(dev 루프 메모리 스토어 결선 —
  loop-memory의 직접 전신)
- `tools/loop-memory/src/schema/memory.ts`(`links` 필드), `src/ops.ts`(addNote/updateNote의 links 입력)
