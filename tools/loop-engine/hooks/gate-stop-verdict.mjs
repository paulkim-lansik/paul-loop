#!/usr/bin/env node
// gate-stop-verdict.mjs — Stop 훅 verdict 게이트 (BAC-564): "검증기가 천장"(CLAUDE.md §1·§8)을 턴
// 종료 시점에 기계 강제한다. 지금까지는 에이전트가 verdict를 돌리고 결과를 자기 판단으로 해석한 뒤
// 턴을 끝냈다(prose 규약) — 이 훅이 있으면 루프 무장 중엔 verdict가 fresh PASS가 아닌 한 턴 종료가
// 구조적으로 차단된다. 반면교사(ECC stop-format-typecheck.js): 객관 신호를 계산해 놓고 항상 exit 0으로
// 버린다 — 이 훅이 하는 것은 그 마지막 한 줄(차단)이다. 검증기를 여기서 *실행*하지는 않는다 — 이미
// 기록된 verdict 상태를 읽기만 한다(실행까지 넣으면 모든 턴 종료가 비싸진다).
//
// 발동 조건(사용자 확정 설계, BAC-564 코멘트 2026-08-04): `.loop/looping` 센티넬이 존재할 때만.
// 센티넬은 loop-fix.sh가 자기 루프 동안 소유하므로(ADR-0081) 일상 대화 세션·평범한 ship 세션과
// 충돌하지 않는다 — 센티넬이 없으면 무출력 exit 0. 센티넬이 살아있는 경우 = ① 무인 드라이버가
// 의도적으로 무장 ② loop-fix가 비정상 종료(trap 미발화)로 흘림 — 둘 다 "verdict PASS 없이 턴을
// 끝내면 안 되는" 맥락이다.
//
// 판정(AC1·AC2·AC5): `.loop/verdict-state.json`(verdict-run.sh가 매 실행 기록: verdict·HEAD sha·
// dirty·timestamp·cmd)을 읽어, verdict==PASS AND 기록 sha==현재 HEAD AND 기록 dirty=false AND 현재
// 트리 clean일 때만 통과한다. FAIL·미기록·파싱 실패·stale sha·dirty(기록 시점/현재)는 전부 차단 —
// exit 2, stderr가 에이전트에게 되돌아간다(공식 Stop 훅 계약, code.claude.com/docs/en/hooks).
// 캐시 리플레이 PASS도 같은 기준이다(BAC-581 계열 stale-green 차단). 미기록을 fail-closed로 차단하는
// 이유: 센티넬 무장 = 루프 맥락이고, 그 맥락에서 "검증기를 아직 안 돌림"은 통과 사유가 될 수 없다 —
// 개발 편의는 킬스위치(LOOP_STOP_GATE_OFF=1, AC7 — 기본 ON)가 흡수한다.
//
// 무한 루프 방지(AC3·AC8): 공식 문서는 stop_hook_active=true면 즉시 exit 0을 권하지만, 그대로 따르면
// 게이트가 1회성 알림으로 퇴화한다(재시도부터 무사통과 — AC8의 "연속 N회 deny"와 양립 불가). 이 훅의
// 루프 상한은 탈출 밸브다: 연속 deny 카운터(`.loop/stop-gate.<session>.json` — 세션별 파일, 공유
// 파일이면 동시 세션 핑퐁이 카운터를 무한 리셋한다, 리뷰 I4)가 MAX_CONSECUTIVE_DENIES회를 넘으면
// 에스컬레이트 systemMessage와 함께 종료를 허용한다(verdict가 구조적으로 FAIL인 상황 — 인프라
// 장애 등 — 에서 세션이 영구히 못 끝나는 것을 방지). 탈출은 PASS로 기록되지 않는다 — verdict 상태
// 파일은 불변, red-events에 탈출 이벤트만 남는다. 탈출 후 같은 세션의 후속 Stop은 즉시 탈출한다
// (카운터가 리셋되지 않는 의도된 stickiness — fresh PASS만이 리셋한다). stop_hook_active는 카운터
// 영속화 실패의 최종 안전망: 카운터를 못 쓰면 상한을 보장할 수 없으므로 stop_hook_active=true(이미
// 한 번 차단된 재시도)면 즉시 탈출 — 무한 루프는 "stdin 파싱과 카운터 영속화가 동시에 계속
// 실패"하는 병리적 조합에서만 남는다(내부 크래시는 동일 원리: 첫 시도 1회 차단, 재시도 통과).
//
// ⚠️ 이 훅은 경계(Gate)가 아니라 가드레일이다(ADR-0036, AC9). 한계를 정직하게 적는다(AC4):
//  - 상태 파일 직접 위조(에이전트가 스스로 PASS 기록)는 protect-during-loop 훅이 막는다 —
//    `.loop/verdict-state.json`·`.loop/stop-gate.*.json`을 `.loop/protect.globs`에 편입했다.
//    그러나 그 훅 자체도 로컬 가드레일이다 — 진짜 경계는 PR 리뷰 + 서버단 브랜치 보호·CI다.
//  - 이 훅은 "어떤 명령의 PASS인지"를 검증하지 못한다 — 사소한 명령(verdict-run.sh -- true)의
//    PASS도 fresh면 통과한다. cmd를 상태에 기록해 사후 감사만 가능하게 한다.
//  - 킬스위치·센티넬 제거·env 우회는 전부 가능하다 — 이 훅의 목적은 "정상 에이전트가 verdict FAIL을
//    자기 판단으로 덮고 턴을 끝내는" 사고를 구조적으로 막는 것이지, 작정한 행위자 차단이 아니다.
// 행위 증명: tools/harness-test/gate-stop-verdict.test.sh (실제 spawn — FAIL 차단·fresh PASS
// 통과·stale/dirty 차단·미기록 차단·센티넬 없음 통과·킬스위치·탈출 밸브·무한루프 방지·배선).

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const MAX_CONSECUTIVE_DENIES = 3; // 연속 3회 차단 후 4번째 시도에서 탈출(AC8 — 설계 판단 3~5 중 최소값)

// biome-ignore lint/suspicious/noUndeclaredEnvVars: Claude Code가 런타임에 주입하는 훅 변수.
let root = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();

// red-events 로거는 동적 import(fire-and-forget) — 정적 import는 로거 파일 부재/문법 오류 시 이
// 모듈 전체를 exit 1(Stop 계약상 비차단)로 즉사시켜 게이트를 조용히 무력화한다(리뷰 H1).
// 로깅은 best-effort, 실패해도 판정 불변. exitCode는 이미 설정된 뒤라 pending import는 무해하다.
const redEvent = (code) => {
  import('./red-events-log.mjs')
    .then((m) => m.logRedEvent(root, { kind: 'stop-gate', code }))
    .catch(() => {});
};

// stdin은 최상위에서 한 번만 읽는다 — 크래시 안전망(catch)에서도 stop_hook_active가 필요하다.
let payload = null;
try {
  payload = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  /* 파싱 실패 → payload=null. 센티넬 무장 중이면 fail-closed로 계속(아래 judge가 차단). */
}
// Resolve the execution worktree only after reading the payload. Unrelated repos cannot reroot.
try {
  const { stopWorkspaceRoot } = await import('../lib/loop-workspace.mjs');
  root = stopWorkspaceRoot(root, payload?.cwd);
} catch (e) {
  console.error(`[gate-stop-verdict] worktree resolver failed: ${e.message}`);
  process.exit(2);
}
const SENTINEL = join(root, '.loop', 'looping');
const STATE = join(root, '.loop', 'verdict-state.json');
const stopHookActive = payload?.stop_hook_active === true;
const sessionId = typeof payload?.session_id === 'string' ? payload.session_id : 'unknown';
// 카운터는 세션 단위 파일(리뷰 I4): 한 파일을 공유하면 같은 워크트리의 무장 세션 2개가 번갈아
// Stop할 때 서로의 기록을 매번 1로 리셋(핑퐁)해 탈출 밸브가 영원히 안 열린다 — 이 레포는 상시
// 동시 병렬 작업 환경이다(CLAUDE.md §8). 세션별 파일이면 연속성이 세션 안에서만 정의되고 상한이
// 보장된다. protect.globs 항목은 `.loop/stop-gate.*.json`.
const COUNTER = join(
  root,
  '.loop',
  `stop-gate.${sessionId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40) || 'unknown'}.json`,
);

function gitOut(args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 3000,
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

const short = (sha) => (typeof sha === 'string' ? sha.slice(0, 7) : String(sha));

// fresh PASS면 null, 아니면 {code, why, hint} — code는 red-events 텔레메트리 사유 코드.
function judge() {
  // A running/abandoned lease is not a completed verification, even if an inner command wrote PASS.
  if (existsSync(join(root, '.loop', 'lifecycle', 'lease'))) {
    return { code: 'stop-loop-active', why: 'loop execution still owns the workspace lease', hint: 'Wait for completion or explicitly recover the interrupted run; an inner PASS does not finish the loop' };
  }
  if (!existsSync(STATE)) {
    return {
      code: 'stop-verdict-missing',
      why: 'verdict 미기록 — 이 루프에서 검증기가 아직 verdict를 남기지 않았다(fail-closed)',
      hint: '`pnpm verdict`(또는 loop-engine@paul-loop 플러그인의 bin/verdict-run.sh -- <verify>, `node tools/plugin-path.mjs exec bin/verdict-run.sh -- <verify>`로 실행)를 실행해 fresh PASS를 기록하라',
    };
  }
  let st;
  try {
    st = JSON.parse(readFileSync(STATE, 'utf8'));
  } catch {
    return {
      code: 'stop-state-unreadable',
      why: 'verdict 상태 파일(.loop/verdict-state.json) 파싱 실패(fail-closed)',
      hint: '검증기(verdict-run.sh)를 재실행해 상태를 재생성하라',
    };
  }
  if (st?.verdict !== 'PASS') {
    return {
      code: 'stop-verdict-fail',
      why: `마지막 verdict가 ${st?.verdict ?? '(unknown)'} (exit=${st?.exit ?? '?'}, at=${st?.finished_at ?? '?'})`,
      hint:
        `FAIL 원인을 고친 뒤 검증기를 재실행해 PASS를 받아라 — 자기 판단이 verdict를 대체하지 ` +
        `않는다(검증기=천장). 로그: ${st?.log ?? '.loop/last-run.log'}`,
    };
  }
  // PASS — 신선도(AC5): 기록 sha==HEAD AND 기록 clean AND 현재 clean.
  let head;
  let dirtyNow;
  try {
    head = gitOut(['rev-parse', 'HEAD']);
    dirtyNow = gitOut(['status', '--porcelain']) !== '';
  } catch (e) {
    return {
      code: 'stop-freshness-failed',
      why: `신선도 확인 실패(git: ${String(e?.message ?? e).split('\n')[0]}) — PASS를 인정할 수 없다(fail-closed)`,
      hint: 'git 저장소 상태를 복구한 뒤 검증기를 재실행하라',
    };
  }
  if (st.sha !== head) {
    return {
      code: 'stop-verdict-stale',
      why: `PASS가 stale — 기록 sha ${short(st.sha)} ≠ 현재 HEAD ${short(head)}`,
      hint: '현재 HEAD에서 검증기를 재실행해 fresh PASS를 만들라(캐시 리플레이 PASS도 같은 기준)',
    };
  }
  if (st.dirty !== false) {
    return {
      code: 'stop-verdict-dirty-at-verify',
      why: 'PASS가 dirty 트리에서 기록됨 — 검증된 내용이 HEAD와 다를 수 있다',
      hint: '변경을 커밋한 뒤 검증기를 재실행해 fresh PASS를 만들라',
    };
  }
  if (dirtyNow) {
    return {
      code: 'stop-tree-dirty-now',
      why: 'fresh PASS 이후 작업트리에 미커밋 변경이 생겼다',
      hint: '변경을 커밋(또는 폐기)한 뒤 검증기를 재실행해 fresh PASS를 만들라',
    };
  }
  return null;
}

function block(failure) {
  // 연속 deny 카운터(AC8) — session_id 단위. 부재·손상·다른 세션이면 0부터.
  let denies = 0;
  try {
    const c = JSON.parse(readFileSync(COUNTER, 'utf8'));
    if (c?.sessionId === sessionId && Number.isInteger(c?.denies) && c.denies >= 0)
      denies = c.denies;
  } catch {
    /* 0부터 */
  }
  denies += 1;
  let counterPersisted = true;
  try {
    mkdirSync(dirname(COUNTER), { recursive: true });
    writeFileSync(
      COUNTER,
      JSON.stringify({ sessionId, denies, updatedAt: new Date().toISOString() }),
    );
  } catch {
    counterPersisted = false;
  }

  const shouldEscape = denies > MAX_CONSECUTIVE_DENIES || (!counterPersisted && stopHookActive);
  if (shouldEscape) {
    redEvent('stop-gate-escape'); // best-effort
    const msg =
      `[gate-stop-verdict] 탈출 밸브: verdict 게이트가 연속 ${MAX_CONSECUTIVE_DENIES}회 차단 후 종료를 ` +
      `허용했다${counterPersisted ? '' : ' (카운터 영속화 실패 — stop_hook_active 안전망)'}. ` +
      `마지막 상태: ${failure.why}. 이 탈출은 PASS가 아니다 — verdict 상태는 그대로 남으며, 사람이 확인해야 한다.`;
    process.stdout.write(JSON.stringify({ systemMessage: msg }));
    console.error(msg); // 브레드크럼
    return; // exit 0 — 종료 허용, PASS 기록 없음(AC8)
  }

  redEvent(failure.code); // best-effort — 판정 불변
  console.error(
    `[gate-stop-verdict] 턴 종료 차단 (연속 ${denies}/${MAX_CONSECUTIVE_DENIES}회): ${failure.why}. ` +
      `다음 행동: ${failure.hint}. ` +
      `이 게이트는 루프 무장(.loop/looping) 동안만 발동하며, 가드레일이지 경계가 아니다(ADR-0036).`,
  );
  process.exitCode = 2; // 공식 Stop 훅 계약: exit 2 = 차단, stderr → 에이전트. (명시적 exitCode — process.exit 금지)
}

function main() {
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: 로컬 디버깅용 킬스위치(AC7) — 기본 ON.
  if (process.env.LOOP_STOP_GATE_OFF === '1') return; // 킬스위치 — 무출력 통과
  if (!existsSync(SENTINEL)) return; // 센티넬 없음 = 일상 세션 무간섭(무출력 exit 0)

  const failure = judge();
  if (!failure) {
    try {
      unlinkSync(COUNTER); // fresh PASS 통과 → "연속" 카운터 리셋
    } catch {
      /* 부재·삭제 실패 무해 — 다음 deny가 세션 불일치로 0부터 세거나 이어 센다 */
    }
    return; // 통과(무출력 exit 0)
  }
  block(failure);
}

try {
  main();
} catch (e) {
  // 예상 밖 내부 오류: 무장 중이면 fail-closed로 1회 차단하되, 재시도(stop_hook_active=true)는
  // 통과시켜 크래시 반복이 무한 루프가 되지 않게 한다(AC3 안전망과 동일 원리).
  const brief = String(e?.message ?? e).split('\n')[0];
  if (stopHookActive) {
    console.error(
      `[gate-stop-verdict] 내부 오류(${brief}) — 재시도라 안전망으로 통과시킨다(사람 확인 필요).`,
    );
    process.exitCode = 0;
  } else {
    console.error(
      `[gate-stop-verdict] 내부 오류(${brief}) — 무장 중이라 fail-closed로 1회 차단한다.`,
    );
    process.exitCode = 2;
  }
}
