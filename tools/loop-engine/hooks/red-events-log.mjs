// RED(차단) 이벤트 계측(BAC-366) — gate-before-merge.mjs(게이트 deny)가 쓰는 append-only 로거.
// "차단율 단조감소" 성장 시계열(GNOSIS 리서치) 실측을 위해 PASS/allow가 아니라 실패/거부만 기록한다.
// 소비(리포트/대시보드)는 범위 밖 — 포착만 먼저.
//
// best-effort: 로그 쓰기 실패가 호출자의 판정(게이트 allow/deny)을 절대 바꾸지 않는다 — 모든 예외를
// 삼킨다. 위치는 `<git-common-dir>/loop-markers/red-events.log`라 모든 워크트리가 공유(cp 브리지 불필요).
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * @param {string} root - 이벤트가 발생한 워크트리(CLAUDE_PROJECT_DIR).
 * @param {{kind: string, code?: string}} event - kind: 'gate'(머지 게이트 deny). code: deny의 사유 코드
 *   (오탐 필터용 — 예: BAC-364 방향-오판 deny를 나중에 골라내기 위함).
 */
export function logRedEvent(root, event) {
  try {
    // 스프레드는 event가 undefined/null/문자열이어도 던지지 않는다 — 그래서 조용히 kind 없는(=이 지표의
    // 목적 자체를 무의미하게 만드는) 로그 줄을 남길 수 있다. 이건 "계측 실패"가 아니라 "조용히 틀린
    // 텔레메트리"라 별도로 막는다(멀티에이전트 리뷰 실측). 그래도 절대 throw는 안 함 — 여전히 no-op.
    if (!event || typeof event.kind !== 'string') {
      console.error('[red-events] logRedEvent에 잘못된 event가 들어와 기록을 건너뜀:', event);
      return;
    }
    // stdio를 억제 — 이 로거가 실패하는 경로(root가 git repo가 아닌 등)는 fail-open으로 조용히 삼켜야
    // 하는데, execFileSync 기본값은 부모 stdio를 상속해 git의 stderr(예: "fatal: not a git repository")가
    // 호출자(gate-before-merge.mjs) 콘솔로 새어나간다 — 계측 실패가 눈에 띄면 안 된다(BAC-366).
    // timeout — deny()의 6개 호출부 전부(내부 오류 fail-closed catch-all 포함)가 이 함수를 거치므로,
    // git이 어떤 이유로든 멈추면 이 훅 전체가 hang한다 — 이 파일 자신의 헤더가 경고하는 바로 그 실패
    // 모드(훅 timeout → fail-open)를 계측 코드가 다시 열면 안 된다. SIGTERM은 여전히 throw → 여전히 catch.
    const git = (args) =>
      execFileSync('git', args, {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 2000,
      }).trim();
    const sha = git(['rev-parse', 'HEAD']);
    const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
    const markerDir = resolve(root, git(['rev-parse', '--git-common-dir']), 'loop-markers');
    mkdirSync(markerDir, { recursive: true });
    const line = JSON.stringify({ ts: new Date().toISOString(), sha, branch, ...event });
    appendFileSync(join(markerDir, 'red-events.log'), `${line}\n`);
  } catch {
    /* best-effort — 계측 실패가 게이트 판정에 영향을 주면 안 된다(BAC-366) */
  }
}
