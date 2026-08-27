// Shared TCP-level liveness probe (node builtins only — no pg driver, no migration state, hermetic-
// testable). Extracted so loop-doctor.mjs (full diagnostic) and loop-doctor-heartbeat.mjs (SessionStart
// nudge, ADR-0062 decision 6) don't carry duplicate copies of the same never-throws logic.
import { connect } from 'node:net';

// `label`은 loop-doctor-heartbeat이 SessionStart nudge로 **에이전트 컨텍스트에 그대로 출력**한다.
// 성공 경로의 label(`host:port`)은 포트까지 숫자로 읽힌 URL이라 구조적으로 연결문자열이 맞고 호스트를
// 남기는 게 진단에 쓸모 있다. 실패 경로 둘은 다르다 — 원본 `urlStr`을 그대로 돌려주고 있었고, 그게 곧
// `postgres://user:password@host/db`다. 게다가 그 경로들은 **URL을 못 믿는 상황에서만** 발동한다:
// `not-a-url-at-all://<secret>`은 WHATWG URL 파싱에 성공하면서 호스트 자리에 시크릿 전체가 들어앉는다.
// 그래서 실패 경로에서는 호스트조차 남기지 않는다 — 무엇이 호스트인지 모르는 상태이기 때문이다.
// 어느 실패인지는 `reason`이 이미 구분해 주므로 진단 정보는 잃지 않는다.
const OPAQUE = '<connection string redacted>';

export function short(e) {
  const m = e && e.message ? e.message : String(e);
  return m.split('\n')[0].slice(0, 120);
}

/** TCP 레벨 연결 시도(node 빌트인만, pg 드라이버·마이그레이션 상태에 안 걸림) — hermetic 테스트 가능.
 *  호출자의 불변식("각 점검 독립 try/catch, 항상 exit 0")을 지키려고 **절대 throw하지 않는다** — URL
 *  파싱 실패·포트 누락처럼 잘못된 설정도 예외가 아니라 실패 값으로 돌려준다. 스킴 없는 값(예:
 *  "localhost:5434")은 WHATWG URL이 hostname 없이 "성공" 파싱해버려 포트가 빈 채로 조용히 5432 같은
 *  엉뚱한 기본값에 붙을 수 있다 — host/port가 비었으면 그것도 명시적 실패로 취급해 그 함정을 막는다. */
export function tcpReachable(urlStr, timeoutMs) {
  let host = '';
  let port = 0;
  try {
    const u = new URL(urlStr);
    host = u.hostname;
    port = Number(u.port);
  } catch (e) {
    return Promise.resolve({ ok: false, label: OPAQUE, reason: `URL 파싱 실패: ${short(e)}` });
  }
  if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) {
    return Promise.resolve({ ok: false, label: OPAQUE, reason: 'host/port를 읽을 수 없음(LOOP_DATABASE_URL 형식 확인)' });
  }
  const label = `${host}:${port}`;
  return new Promise((resolve) => {
    const sock = connect({ host, port });
    const done = (ok, reason) => {
      sock.destroy();
      resolve({ ok, label, reason: reason ?? '' });
    };
    sock.setTimeout(timeoutMs, () => done(false, `${timeoutMs}ms 타임아웃`));
    sock.once('connect', () => done(true));
    sock.once('error', (e) => done(false, short(e)));
  });
}
