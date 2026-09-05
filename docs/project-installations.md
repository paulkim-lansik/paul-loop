# 프로젝트 설치와 업데이트

프로젝트에는 runtime·marketplace/plugin ID·검토한 버전만 기록한다. 사용자 이름과
캐시 절대 경로는 Git에 넣지 않는다. `scripts/project-plugin.mjs`는 외부 의존성이 없는
Node 22 스크립트이며 소비 저장소의 `tools/paul-loop.mjs`로 복사할 수 있다.

## Codex 설정 예시

`.codex/paul-loop.lock.json`:

```json
{
  "schemaVersion": 1,
  "runtime": "codex",
  "plugins": {
    "loop-engine": { "id": "loop-engine@paul-loop-codex", "version": "0.15.0" },
    "ship-flow": { "id": "ship-flow@paul-loop-codex", "version": "0.11.0" }
  }
}
```

이 ID를 사용하려면 [일반 Codex 설치 절차](codex-installation.md)로 해당 marketplace를
먼저 등록·설치한다. Zine 파생물을 쓰는 기존 프로젝트는 `zine-codex` ID와
`0.15.0+zine.1`/`0.11.0+zine.1` 버전을 유지한다. 같은 이름의 다른 marketplace를 대신
선택하지 않는다. 하나의 프로젝트 lock에는 `.codex` 또는 `.claude` 한 runtime만 사용한다.

기존 ship-flow 설정의 다른 값은 보존하고 `pluginBinPrefix`만 다음으로 지정한다.

```json
{ "pluginBinPrefix": "node tools/paul-loop.mjs exec bin/" }
```

```bash
node tools/paul-loop.mjs doctor
node tools/paul-loop.mjs sync
node tools/paul-loop.mjs exec bin/runtime-doctor.mjs
node tools/paul-loop.mjs update
```

- `doctor`: host 설치 등록과 lock 버전, 실제 artifact manifest를 검사한다. 프로젝트 설정이나 설치본을 바꾸지 않는다.
- `exec`: 같은 검사를 거친 실행 경로와 runtime 환경으로 bin 명령을 실행한다. shell로
  인자를 다시 해석하지 않고 자식의 종료 코드를 보존한다. launcher는 설치나 설정 갱신을 하지 않는다. 자식 명령은 요청된 작업의 파일을 쓸 수 있다.
- `sync`: 현재 검증된 설치의 절대 경로를 로컬 `.codex/paul-loop.plugins.json`에 생성한다.
  이 파일은 `.gitignore`에 추가한다. lock은 Git에 추적하고 다른 프로젝트 설정은 보존한다.
- `update`: lock에 지정한 설치만 공식 CLI로 갱신하고 실제 새 캐시를 검사한 뒤 lock과
  로컬 registry를 갱신한다. lock 변경은 검토·커밋 대상이다. Git marketplace만 먼저
  refresh하며, 로컬 marketplace는 그 원본을 먼저 갱신해야 한다.

Codex 0.146과 앱 내장 0.153.1의 plugin list JSON은 cache path를 제공하지 않는다. 이 launcher는
검증한 `${CODEX_HOME:-~/.codex}/plugins/cache/<market>/<plugin>/<version>` adapter를 사용하고,
실제 CLI 버전이 0.146.x 또는 0.153.1이고 설치 등록과 캐시 manifest가 모두 일치해야 실행한다.
0.153.1은 임시 HOME에서 공식 CLI의 LOCAL 등록·설치와 실제 cache의 bytes/mode를 대조했다.
다른 0.153 버전의 호환성까지 확인한 것은 아니다. CLI가 설치 경로를 제공하거나
레이아웃을 바꾸면 adapter를 다시 검증해야 한다. source 경로를 설치 캐시로 오인하거나
다른 버전을 검색해 대체하지 않는다.

공식 host CLI 조회는 자체 로그·캐시를 만들 수 있다. 이 도구의 조회 보존 계약은 프로젝트
설정과 설치 상태에 적용되며, 운영체제 전체에 쓰기가 전혀 없다는 보장이 아니다.

## Claude와 복수 프로젝트

Claude는 `.claude/paul-loop.lock.json`에 `runtime: "claude"`, `@paul-loop` ID,
0.15.0/0.11.0 버전과 필요한 `scope: "user"|"project"|"local"`을 기록한다.
scope 생략 시 같은 프로젝트의 local → project → user 순서로 선택한다. 다른 프로젝트의
project/local 등록은 사용하지 않는다. Claude native 설치 위치는 CLI의 installPath를 따른다.

공통 도구가 있는 checkout에서 명시한 프로젝트들을 순차 갱신할 수 있다.

```bash
for project in /path/to/project-a /path/to/project-b; do
  node scripts/project-plugin.mjs --project "$project" update || break
done
```

자동 전수 검색이나 worktree 일괄 덮어쓰기는 하지 않는다. 각 프로젝트의 lock을 기준으로
갱신한다. disabled Codex 설치는 add가 활성 상태를 바꿀 수 있어 사전에 거부한다.
Claude update는 기존 활성 상태가 보존됐는지 재검사한다. `loop-memory`는 lock에 명시한
기존 설치만 처리하며, 기본 예시에 포함하지 않는다.

## 보존과 부분 실패

Vendored lock entry는 ID 대신 registry 디렉터리 기준 상대 `path`를 사용한다. 해당 복사본은
doctor/exec로 확인할 수 있지만 `update`는 거부한다. Zine의 검토된 overlay updater처럼
소유권과 로컬 수정을 이해하는 도구로 먼저 갱신한다.

프로젝트 lock·registry가 실행 도중 바뀌면 덮어쓰지 않는다. 변경 전 파일의 실제 inode는 로컬
`.loop/plugin-updates/`에 보존하며, 새 파일은 기존 경로를 덮어쓰지 않는 hard link로 공개한다.
이 때문에 POSIX 로컬 파일시스템의 같은 볼륨이 필요하다. 동시 편집이 발견되면 실패하고
복구 오류와 남긴 파일 위치를 출력한다. 여러 파일의 공개가 하나의 원자적 트랜잭션인 것은 아니다. 글로벌 host 업데이트와 여러 프로젝트 파일은 하나의
트랜잭션이 아니므로, host 갱신 후 캐시 검증/동기화 실패는 **부분 완료**다. 오류를 확인하고
현재 host 설치와 lock을 대조한 뒤 복구한다. 자동으로 이전 버전을 다시 설치하지 않는다.
hook trust, 기존 profile, memory 인프라, 프로젝트의 verifier/risk 규칙은 바꾸지 않는다.

설치·registry PASS는 native hook이나 모델 행동의 증명이 아니다. 갱신된 스킬은 새 Codex
작업/재시작한 Claude 세션에서 불러온다.
