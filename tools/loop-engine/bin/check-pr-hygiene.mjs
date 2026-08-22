#!/usr/bin/env node
// bin/check-pr-hygiene.mjs — BAC-754 (ported from glucofit-partners' tools/check-pr-hygiene.mjs,
// originally BAC-629 — ouroboros O7 채택, see that repo's docs/research/2026-08-04-ouroboros-
// benchmarking.md §4.4/§6 for the source study).
//
// PR 본문이 최소 1개의 트래킹 이슈를 참조하는지 검사한다. ouroboros 실측 감사(30일 merged PR 80개
// 중 17개 무참조, 닫힌 이슈 11개 중 6개가 이미 구현된 채 방치)에서 온 게이트 — 관행에만 의존한 참조는
// 조용히 새어나간다.
//
// 이슈 id 패턴은 소비 레포마다 다르다(BAC-*/PRO-*, JIRA 스타일 PROJ-*, 그 외) — `--pattern`으로
// 주입하고, 아무 것도 안 주면 흔한 "영문 접두사-숫자" 트래커 관례(BAC-123·PRO-123·JIRA의 PROJ-123
// 등)를 두루 잡는 일반 정규식으로 기본 동작한다. 소비 레포는 자기 트래커 id 패턴을
// `.claude/ship-flow.config.json`(예: `trackerIdPattern`)에 두고 CI/스킬 호출부에서 `--pattern`으로
// 넘기는 것을 권장한다(ship-flow의 setup/publisher가 이 값을 읽어 넘긴다).
//
// 의도적으로 **closing 키워드(Closes/Fixes #N)가 아니라 참조 존재만** 요구한다 — 트래커가 GitHub
// 키워드로 자동 close되지 않는 경우가 흔하고(Linear 등), 강제하면 "임시로 키워드를 넣었다가 빼먹어
// 오발 close"라는 별도 실패모드만 늘어난다(ouroboros 설계 그대로).
//
// Exit 0 = 참조 있음. Exit 1 = 없음. --json으로 기계가독 결과.

import { readFileSync } from 'node:fs';

// case-insensitive — 목적은 "참조가 존재하는가"이지 표기 규칙 검사가 아니다.
const DEFAULT_REF_PATTERN = /\b[A-Z]{2,}-\d+\b/i;

function parseArgs(argv) {
  const opts = { body: undefined, bodyFile: undefined, json: false, pattern: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--body') opts.body = argv[++i];
    else if (a === '--body-file') opts.bodyFile = argv[++i];
    else if (a === '--pattern') opts.pattern = argv[++i];
    else if (a === '--json') opts.json = true;
  }
  return opts;
}

function resolveBody(opts) {
  if (opts.body !== undefined) return opts.body;
  if (opts.bodyFile !== undefined) return readFileSync(opts.bodyFile, 'utf8');
  return readFileSync(0, 'utf8'); // stdin
}

function resolvePattern(raw) {
  if (!raw) return DEFAULT_REF_PATTERN;
  return new RegExp(raw, 'i');
}

export function checkPrHygiene(body, pattern = DEFAULT_REF_PATTERN) {
  const text = body ?? '';
  const match = text.match(pattern);
  return { ok: match !== null, matched: match?.[0] ?? null };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const body = resolveBody(opts);
  const pattern = resolvePattern(opts.pattern);
  const result = checkPrHygiene(body, pattern);

  if (opts.json) {
    console.log(JSON.stringify(result));
  } else if (result.ok) {
    console.log(`PASS: PR body references ${result.matched}`);
  } else {
    console.error(
      'FAIL: PR body에 트래킹 이슈 참조가 없습니다. closing 키워드는 필요 없습니다 — ' +
        '그냥 이슈 번호를 본문 어딘가에 적어주세요.',
    );
  }

  process.exit(result.ok ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
