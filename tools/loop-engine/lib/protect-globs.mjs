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
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

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
    // (BAC-785 이후: 대상이 root 밖이면 호출자가 이미 재루팅으로 git을 스폰한 뒤다. 이 절약은 root
    // 안 편집에서만 온전하다 — 그래도 아끼지 않을 이유는 없다.)
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

// ── 실효 루트 해석 (BAC-785) ──────────────────────────────────────────────────────────────────────
// 무장 판정과 glob 매칭의 루트가 세션의 CLAUDE_PROJECT_DIR로 고정돼 있으면, 워크트리 격리 세션에서
// 그건 메인 워크트리(비보호 브랜치)를 가리킨다 — 즉 이 레포가 규약으로 강제하는 바로 그 작업 방식에서
// 가드가 한 번도 무장되지 않는다. 그래서 루트를 "무엇을 만지는가"에서 도출한다.

/** 경로가 root 안(자기 자신 포함)인가. root 밖일 때만 재루팅을 시도한다. */
export function isInsideRoot(root, p) {
  const rel = relative(root, resolve(p)).split('\\').join('/');
  return rel === '' || (rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel));
}

function gitOut(args, cwd) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    timeout: 3000,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

/**
 * 저장소 식별자 — 링크드 워크트리끼리는 같은 값이 나온다. 실패는 null.
 * `--git-common-dir`은 메인 워크트리에서 상대(`.git`), 링크드에서 절대 경로를 낸다. 게다가 macOS의
 * /var는 /private/var 심링크라 같은 디렉토리가 두 철자를 가진다 — 그래서 호출 cwd 기준으로 resolve한
 * 뒤 realpath까지 해야 비교가 성립한다(gate-before-merge.mjs가 같은 이유로 같은 정규화를 한다).
 */
function repoId(dir) {
  try {
    return realpathSync(resolve(dir, gitOut(['rev-parse', '--git-common-dir'], dir).trim()));
  } catch {
    return null;
  }
}

/** root와 대상 사이(대상 쪽 끝부터)에 `.git` 엔트리를 가진 디렉토리가 있는가 — 중첩 워크트리/레포. */
function nestedRepoBelow(root, abs) {
  const top = resolve(root);
  const rel = relative(top, dirname(abs)).split('\\').join('/');
  if (!rel || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) return false;
  const segs = rel.split('/');
  for (let i = segs.length; i > 0; i--) {
    if (existsSync(join(top, ...segs.slice(0, i), '.git'))) return true;
  }
  return false;
}

// repoId(root)는 프로세스 수명 동안 불변인데 한 번의 훅 호출에서 최대 두 번 조회된다(대상 시도 +
// 세션 cwd 폴백). 핫패스라 memoize한다 — undefined = 아직 미조회, null = 조회했고 실패.
let rootIdCache;
function rootRepoId(root) {
  if (rootIdCache === undefined) rootIdCache = repoId(root);
  return rootIdCache;
}

/**
 * 대상 경로가 속한 *root와 같은 저장소의* 워크트리 → `{ top, rel }`. 그 외 전부 null.
 * null = 재루팅하지 않는다(root 안 · 다른 저장소 · 비-git · 조회 실패). 범위를 같은 저장소로 좁히는
 * 건 의도다 — 무관한 레포까지 보호하도록 넓히면 스코프 확장이고, 기존 동작(비보호) 유지가 안전하다.
 */
export function resolveWorktreeRoot(root, target) {
  if (!target) return null;
  const abs = resolve(target);
  // root 안이라도 그 아래 중첩된 워크트리(`.worktrees/…`)면 별개 브랜치·별개 `.loop`다 — 소비 레포
  // 규약이 명시 허용하는 배치라 "root 안 = 재루팅 불필요"로 단락시키면 거기서 가드가 통째로 꺼진다.
  // 판정은 git 스폰 없이 파일시스템만으로 한다: 이 경로는 툴콜마다 도는 핫패스라, 평범한 root 안
  // 편집에서 git 호출이 늘어나면 안 된다.
  if (isInsideRoot(root, abs) && !nestedRepoBelow(root, abs)) return null;
  let dir = abs;
  let suffix = '';
  let isDir = false;
  try {
    isDir = statSync(abs).isDirectory();
  } catch {
    // 미존재 → 파일로 취급(아직 쓰이지 않은 새 파일)
  }
  if (!isDir) {
    dir = dirname(abs);
    // suffix의 초기값이 basename(abs)라는 게 계약의 일부다. 빼면 존재하는 파일에서 rel이 ''이 되어
    // 어떤 glob도 매칭되지 않고 — 가장 흔한 케이스만 조용히 뚫린다.
    suffix = basename(abs);
  }
  // 아직 만들어지지 않은 디렉토리 아래의 새 파일: `git -C <미존재 경로>`는 exit 128이다. 존재하는
  // 최초의 조상까지 올라가며 지나친 구간을 suffix 앞에 붙인다. 보호 대상인 `**/*.test.sh`를 *새
  // 디렉토리에* 만드는 경로가 정확히 리워드핵 벡터라 여기서 포기하면 안 된다. 상한은 두지 않는다 —
  // 아래 repoId 동일성 검사가 걸러내므로 위로 새는 재루팅이 원리적으로 불가능하다.
  while (!existsSync(dir)) {
    const parent = dirname(dir);
    if (parent === dir) return null;
    suffix = suffix ? `${basename(dir)}/${suffix}` : basename(dir);
    dir = parent;
  }
  let top;
  let prefix;
  try {
    // 워크트리 루트에서 `--show-prefix`는 빈 줄이라, `.trim()` 후 split 하면 배열이 1칸이 되어
    // `lines[1]`이 사라진다. 실질 방어자는 split 순서가 아니라 아래의 `?? ''`다 — 둘 다 두는 건
    // 값이 undefined인 채 rel에 문자열 연결되는(=조용히 틀린 경로) 사고를 두 겹으로 막기 위해서다.
    const lines = gitOut(['rev-parse', '--show-toplevel', '--show-prefix'], dir).split('\n');
    top = (lines[0] ?? '').trim();
    prefix = (lines[1] ?? '').trim();
  } catch {
    return null;
  }
  if (!top) return null;
  const id = repoId(dir);
  if (id === null || id !== rootRepoId(root)) return null;
  // rel을 relative()로 만들지 않는 이유: `--show-toplevel`은 물리 경로(/private/var/...)를 내는데
  // payload의 대상 경로는 심링크 철자(/var/...)일 수 있어 문자열 비교가 깨진다. prefix+suffix는 git이
  // 직접 계산한 값이라 그 문제가 없다.
  return { top, rel: `${prefix}${suffix}` };
}
