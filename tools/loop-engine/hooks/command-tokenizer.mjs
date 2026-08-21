// command-tokenizer.mjs — Bash 명령 문자열의 공유 근사 토크나이저 (BAC-563에서 gate-before-merge.mjs로부터
// 추출 — 구현은 그대로, 집만 이동). 소비자: gate-before-merge.mjs(머지 방향 게이트)와
// gate-risky-commands.mjs(머지·배포 표면 게이트). 중복 구현 금지 — 두 훅의 감지가 같은 파서 위에 서야
// 파서 교훈이 한 곳에 산다. 계보: heredoc 처리=BAC-349, env-프리픽스 관통=초기 적대 리뷰(C-A,
// BAC-364보다 앞선다). BAC-364의 파서 교훈(git 전역옵션·checkout 생성/값 플래그)은 여전히
// gate-before-merge.mjs의 parseGit/checkoutTarget에 산다 — 아래 firstSubcommand는 그 계보(값-플래그
// 스킵)를 이 파일로 가져온 gh/pnpm용 헬퍼다.
//
// ⚠️ 결합 주의(S-1): 이 파일(stripPrefix/tokenize/stripHeredocs/…)을 바꾸면 두 소비자 훅의 감지가
// *함께* 바뀐다 — gate-hook.test.sh와 gate-risky-commands-hook.test.sh를 둘 다 돌려 확인할 것.
//
// ⚠️ 완전한 셸 파서가 아니다(coarse-net, ADR-0036) — eval/bash -c/따옴표/node -e를 못 흉내낸다. 소비자는
// 감지 단계를 fail-open으로 다뤄야 한다(파서 하드닝은 won't-fix).

// heredoc 시작 마커(`<<EOF`·`<<'EOF'`·`<<"EOF"`·`<<-EOF`, 따옴표·대시 조합 포함)부터, 그 줄과 정확히
// 일치하는(단 `<<-`는 선행 탭 허용) 종료 줄까지(포함)를 통째로 들어낸다 — 완전한 셸 heredoc 문법이 아니라
// 이 레포 관용구를 겨냥한 근사치. here-string(`<<<word`)은 시작으로 안 본다(음의 lookbehind로 제외 — 그
// 자체가 heredoc이 아니고, 또한 헤어스트링이면 종료 마커가 있을 리 없어 아래 케이스로 흘러 데이터 유실
// 위험만 남긴다). 종료 마커를 못 찾으면(비정상 입력이거나 애초에 heredoc이 아니었던 오탐) 원문을 그대로
// 되돌린다(H-1) — 못 찾았다고 지워버리면 그 뒤에 있는 실제 명령까지 사라져 탐지가 fail-open으로 뚫린다.
export function stripHeredocs(command) {
  const lines = command.split('\n');
  const startRe = /(?<!<)<<(-)?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/;
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    out.push(line);
    i += 1;
    const m = startRe.exec(line);
    if (!m) continue;
    const [, dash, , delim] = m;
    const bodyStart = i;
    let closed = false;
    while (i < lines.length) {
      const body = dash ? lines[i].replace(/^\t+/, '') : lines[i];
      i += 1;
      if (body === delim) {
        closed = true;
        break;
      }
    }
    if (!closed) {
      // 스프레드 복원(out.push(...slice))은 ~12.5만 요소부터 V8 호출 인자 한도로 RangeError를 던진다
      // (리뷰 실측: 20만 줄 미종결 heredoc → gate-risky-commands는 catch로 조용히 defer,
      // gate-before-merge는 비차단 크래시 — 둘 다 fail-open). 인덱스 루프로 복원한다.
      for (let j = bodyStart; j < i; j++) out.push(lines[j]);
    }
  }
  return out.join('\n');
}

export const splitSegments = (command) =>
  command
    .split(/&&|\|\||[;|\n&]/)
    .map((s) => s.trim())
    .filter(Boolean);

export const tokenize = (seg) => seg.split(/\s+/).filter(Boolean);

// 선행 env 할당(FOO=bar)·env/command/nohup/nice/time/sudo 프리픽스를 벗긴다 — `GIT_SSH_COMMAND=… git
// merge` 같은 환경변수 프리픽스나 `time pnpm deploy`·`sudo git merge` 같은 워드 프리픽스로 감지를
// 우회하지 못하게(C-A + BAC-563 리뷰 S-1 — time/sudo 추가는 두 소비자 훅 모두를 더 보수적으로 만든다).
export function stripPrefix(toks) {
  let i = 0;
  while (
    i < toks.length &&
    (/^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[i]) ||
      toks[i] === 'env' ||
      toks[i] === 'command' ||
      toks[i] === 'nohup' ||
      toks[i] === 'nice' ||
      toks[i] === 'time' ||
      toks[i] === 'sudo')
  ) {
    i += 1;
  }
  return toks.slice(i);
}

// 바이너리(gh·pnpm 등) 뒤에서 플래그 토큰을 건너뛰고 첫 서브커맨드(비-플래그 토큰)의 인덱스를 돌려준다.
// valueFlags에 든 플래그는 다음 토큰을 값으로 함께 소비한다(`--repo=x` 같은 단일 토큰 형태는 값 소비
// 없음 — parseGit의 VALUE_GLOBAL 처리와 동일 계보, BAC-364). 목록에 없는 값-플래그는 오파싱될 수 있다
// (coarse-net) — 소비자는 감지 단계 fail-open(defer)으로 흡수한다.
export function firstSubcommand(toks, from, valueFlags) {
  let i = from;
  while (i < toks.length && toks[i].startsWith('-')) {
    i += valueFlags.has(toks[i]) && !toks[i].includes('=') ? 2 : 1;
  }
  return i;
}

// git 전역옵션(다음 토큰이 값) — `git [이 옵션들...] <subcommand>`에서 subcommand 위치를 찾을 때
// firstSubcommand와 함께 쓴다. gate-before-merge.mjs(parseGit)·gate-worktree-create.mjs·
// worktree-remove-cleanup.mjs 공용(BAC-615 리뷰 — 각 훅이 이 집합을 따로 복제하지 않게 여기 하나로).
export const GIT_VALUE_GLOBAL = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--exec-path',
  '--super-prefix',
]);
