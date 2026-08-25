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
// ── 리뷰어 커버리지 (BAC-778, opt-in) ─────────────────────────────────────────────────────────
// `--reviewers a,b,c`를 주면 PR 본문이 **각 리뷰어의 결과 블록**을 담고 있는지도 검사한다. 계기(실측):
// 감사한 어떤 런은 필수 리뷰 에이전트 3종 중 2종만 소환하고 PR을 열었는데 아무 게이트도 잡지 못했다 —
// "3종 다 돌렸다"가 관행으로만 존재하면 조용히 2종이 된다(참조 게이트와 같은 실패 모드).
//
// 리뷰어 이름은 **소비 레포의 것**이라 여기 하드코딩하지 않는다(이 플러그인은 제품 고유 규칙을 싣지
// 않는다 — `--pattern`과 같은 설계). 값은 `.claude/ship-flow.config.json`에 두고 CI/스킬 호출부에서
// `--reviewers`로 넘기는 것을 권장한다. 플래그가 없으면 이 검사는 아예 돌지 않는다(기존 계약 불변).
//
// "결과 블록"의 판정: 리뷰어 이름이 나오는 줄 **또는 그 다음 2줄 안**에 결과 토큰이 있어야 한다
// (`--result-pattern`으로 교체 가능). 이름만 스쳐 지나가는 산문("test-hunter는 생략했다")은 통과하지
// 못하고, 표제+판정이 붙어 있는 실제 결과 블록은 형식(제목/표/불릿)과 무관하게 통과한다.
//
// Exit 0 = 참조 있음(+ 리뷰어 지정 시 전원 커버). Exit 1 = 하나라도 미달. --json으로 기계가독 결과.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// case-insensitive — 목적은 "참조가 존재하는가"이지 표기 규칙 검사가 아니다.
const DEFAULT_REF_PATTERN = /\b[A-Z]{2,}-\d+\b/i;
// 결과 토큰의 기본값 — 영/한 양쪽의 흔한 판정 어휘. 소비 레포는 --result-pattern으로 갈아끼운다.
const DEFAULT_RESULT_PATTERN =
  /\b(PASS(?:ED)?|FAIL(?:ED)?|BLOCK(?:ER|ERS|ED)?|APPROVED?|NO[- ]?BLOCKERS?)\b|통과|차단|블로커/i;
// 이름 줄 + 이어지는 2줄 — 제목 밑에 판정이 오는 흔한 형태를 담되, 다음 리뷰어 블록까지 넘어가지는
// 않을 만큼 좁게.
const RESULT_WINDOW = 2;

function parseArgs(argv) {
  const opts = {
    body: undefined,
    bodyFile: undefined,
    json: false,
    pattern: undefined,
    reviewers: undefined,
    resultPattern: undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--body') opts.body = argv[++i];
    else if (a === '--body-file') opts.bodyFile = argv[++i];
    else if (a === '--pattern') opts.pattern = argv[++i];
    else if (a === '--reviewers') opts.reviewers = argv[++i];
    else if (a === '--result-pattern') opts.resultPattern = argv[++i];
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

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// 리뷰어 이름 목록 파싱 — 쉼표 구분, 공백 무시, 빈 항목 제거.
export function parseReviewers(raw) {
  if (typeof raw !== 'string') return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function checkReviewerCoverage(
  body,
  reviewers,
  resultPattern = DEFAULT_RESULT_PATTERN,
  window = RESULT_WINDOW,
) {
  const lines = String(body ?? '').split('\n');
  const covered = [];
  const missing = [];
  for (const name of reviewers) {
    // 경계에서 하이픈·언더스코어를 제외한다 — 리뷰어 이름 안에는 흔하지만(`code-reviewer`), 경계로
    // 인정하면 `meta-code-reviewer`가 `code-reviewer`를 만족시켜 버린다(다른 에이전트다). 콜론·슬래시·
    // 공백·마크다운 장식은 경계로 인정되므로 `### code-reviewer`·`**code-reviewer**`·
    // `ship-flow:code-reviewer`는 그대로 잡힌다.
    const nameRe = new RegExp(`(^|[^A-Za-z0-9_-])${escapeRe(name)}([^A-Za-z0-9_-]|$)`, 'i');
    let hit = false;
    for (let i = 0; i < lines.length && !hit; i++) {
      if (!nameRe.test(lines[i])) continue;
      hit = lines.slice(i, i + window + 1).some((l) => resultPattern.test(l));
    }
    (hit ? covered : missing).push(name);
  }
  return { ok: missing.length === 0, covered, missing };
}

export function checkPrHygiene(body, pattern = DEFAULT_REF_PATTERN, opts = {}) {
  const text = body ?? '';
  const match = text.match(pattern);
  const result = { ok: match !== null, matched: match?.[0] ?? null };
  const reviewers = opts.reviewers ?? [];
  if (reviewers.length) {
    result.reviewers = checkReviewerCoverage(text, reviewers, opts.resultPattern);
    result.ok = result.ok && result.reviewers.ok;
  }
  return result;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const body = resolveBody(opts);
  const pattern = resolvePattern(opts.pattern);
  const reviewers = parseReviewers(opts.reviewers);
  const result = checkPrHygiene(body, pattern, {
    reviewers,
    resultPattern: opts.resultPattern ? new RegExp(opts.resultPattern, 'i') : undefined,
  });

  if (opts.json) {
    console.log(JSON.stringify(result));
  } else {
    if (result.matched) console.log(`PASS: PR body references ${result.matched}`);
    else
      console.error(
        'FAIL: PR body에 트래킹 이슈 참조가 없습니다. closing 키워드는 필요 없습니다 — ' +
          '그냥 이슈 번호를 본문 어딘가에 적어주세요.',
      );
    if (result.reviewers) {
      if (result.reviewers.ok) {
        console.log(`PASS: PR body has result blocks for ${result.reviewers.covered.join(', ')}`);
      } else {
        console.error(
          `FAIL: PR body에 다음 리뷰 에이전트의 결과 블록이 없습니다: ${result.reviewers.missing.join(', ')}. ` +
            '소환했다면 각 리뷰어 이름과 그 판정(PASS/FAIL/블로커 유무)을 본문에 함께 적어주세요 — ' +
            '"돌렸다"는 자기보고는 증거가 아닙니다.',
        );
      }
    }
  }

  process.exit(result.ok ? 0 : 1);
}

// `import.meta.url`은 percent-encoding된다(공백·비ASCII → %XX). `file://${process.argv[1]}`는 raw
// OS 경로라, 체크아웃 경로에 공백이나 한글이 하나라도 있으면 두 문자열이 조용히 어긋나 아래 CLI
// 블록이 통째로 실행되지 않는다 — 출력 0줄에 exit 0이라, 호출자는 "게이트 통과"로 읽는다(실측:
// 같은 파일을 공백 있는 경로에 두면 출력이 사라진다). pathToFileURL()이 argv[1]을 같은 방식으로
// 정규화한다. 앞의 `process.argv[1] &&`는 argv[1]이 없는 맥락(`node -e`, 워커)에서 pathToFileURL이
// 던지지 않게 한다 — 리졸버/게이트는 어떤 맥락에서도 import만으로 죽으면 안 된다. (BAC-699 → BAC-792)
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
