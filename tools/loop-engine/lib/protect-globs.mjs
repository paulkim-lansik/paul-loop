// 리워드핵 가드의 단일 진실 — glob matcher + 무장 상태 판정 (BAC-583, ADR-0081).
// 훅(.claude/hooks/protect-during-loop.mjs)·loop-doctor·회귀테스트(protect-globs-coverage /
// guard-arming)가 전부 이 구현을 import한다. 이전엔 훅이 globToRegExp를 사유화해서, 커버리지를
// 검사하려면 복제본으로 판정할 수밖에 없었고(이슈 본문의 실측 프로브가 그랬다) 복제본은 드리프트로
// false-green을 낳는다 — 그래서 matcher를 여기로 빼 test surface로 만들었다.
//
// 무장 규칙 (ADR-0081 — 산문 무장 폐기, 구조적 상시무장):
//   1. `.loop/looping` 존재 → ARMED (loop-fix.sh가 자기 루프 동안 소유하는 하드 센티넬.
//      guard-off보다 우선 — 명시적 루프 중의 옵트아웃은 허용하지 않는다)
//   2. 브랜치 조회 실패(비-git 디렉토리·detached HEAD) → UNARMED (fail-open: 임시 디렉토리의
//      hermetic 테스트, origin/main 기준 detached 배포 워크트리)
//   3. 브랜치 ∈ {develop, main, master} → UNARMED (메인/릴리스 워크트리 — QA·사람 작업 공간)
//   4. `.loop/guard-off` 유효(사유 텍스트 非공백 + mtime 나이 < TTL) → UNARMED (사유 있는
//      옵트아웃 창 — tdd RED 단계·정당한 config 편집의 우회 경로. 빈 파일·만료는 무효=무장 유지)
//   5. 그 외 → ARMED (feature/* 등 작업 브랜치 상시 무장 — 에이전트의 산문 기억에 의존하지 않는다)
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// 옵트아웃 창은 짧게 — 영구 OFF(38일 화석화·워크트리 6개 전부 비무장)가 이 이슈의 병인이다.
export const GUARD_OFF_TTL_MS = 30 * 60 * 1000;
export const UNPROTECTED_BRANCHES = new Set(['develop', 'main', 'master']);

// glob 패턴엔 절대 안 나타나는 토큰(이스케이프·* ? 치환을 통과해 마지막에 최종 정규식으로 바뀐다).
const SEG = '@@SEG@@'; // **/ 자리표시
const ANY = '@@ANY@@'; // ** 자리표시

/** 단순 glob → RegExp. `**` / `*` / `?` 지원(protect.globs의 패턴 집합에 충분). */
export function globToRegExp(glob) {
  const re = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&') // 정규식 메타 이스케이프(* ? / 는 제외)
    .replaceAll('**/', SEG)
    .replaceAll('**', ANY)
    .replaceAll('*', '[^/]*')
    .replaceAll('?', '[^/]')
    .replaceAll(SEG, '(?:.*/)?') // **/ → 0개 이상의 경로 세그먼트
    .replaceAll(ANY, '.*'); // ** → 임의
  return new RegExp(`^${re}$`);
}

/** protect.globs 파일 → 패턴 배열(주석·공백 줄 제외). 파일이 없으면 []. */
export function loadPatterns(globFile) {
  if (!existsSync(globFile)) return [];
  return readFileSync(globFile, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

/** 현재 브랜치명. 비-git·detached·조회 실패는 '' (fail-open 신호). */
export function currentBranch(root) {
  try {
    return execFileSync('git', ['-C', root, 'branch', '--show-current'], {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

/**
 * 무장 상태 판정 → { armed, mode, branch, reason?, ageMs? }
 * mode: 'sentinel' | 'no-branch' | 'unprotected-branch' | 'guard-off' | 'guard-off-empty'
 *     | 'guard-off-expired' | 'branch'
 */
export function guardState(root, now = Date.now()) {
  if (existsSync(join(root, '.loop', 'looping'))) {
    // 센티넬 = loop-fix 루프의 핫패스(툴콜마다 훅 발화) — git 스폰을 아끼려 브랜치는 조회하지 않는다.
    return { armed: true, mode: 'sentinel', branch: '' };
  }
  const branch = currentBranch(root);
  if (!branch) return { armed: false, mode: 'no-branch', branch };
  if (UNPROTECTED_BRANCHES.has(branch)) return { armed: false, mode: 'unprotected-branch', branch };
  const off = join(root, '.loop', 'guard-off');
  if (existsSync(off)) {
    try {
      const reason = readFileSync(off, 'utf8').trim();
      const ageMs = now - statSync(off).mtimeMs;
      if (!reason) return { armed: true, mode: 'guard-off-empty', branch };
      if (ageMs > GUARD_OFF_TTL_MS) return { armed: true, mode: 'guard-off-expired', branch, reason, ageMs };
      return { armed: false, mode: 'guard-off', branch, reason, ageMs };
    } catch {
      return { armed: true, mode: 'branch', branch }; // 읽기 실패 → fail-closed(무장 유지)
    }
  }
  return { armed: true, mode: 'branch', branch };
}
