# Runtime portability 구현 및 검증 인계

작업 위치: `/Users/jinhokim/dev/paul-loop-hardening`, `codex/harness-audit-hardening`.
포팅 구현은 부모의 전체 통합 검증에 넘길 수 있다. 원본 checkout, 설치된 플러그인/프로필,
원격 정책은 수정하지 않았고 commit/push/tag/release/install 및 모델 호출은 실행하지 않았다.

## 구현 범위

| 변경 경로 | 최종 동작 |
|---|---|
| `tools/loop-engine/bin/plugin-path.mjs` | 이름·런타임·버전 검증, 명시적 override/registry, CLAUDE_CONFIG_DIR, 동일 저장소 worktree fallback, 별도 Codex artifact mapping. 실행 시 argv/cwd/exit 유지, bin escape 거부 |
| `tools/loop-engine/hooks/protect-during-loop.mjs`, `lib/patch-paths.mjs`, `runtime/protected-state.mjs` | apply_patch 전체 경로 및 move 양 끝 검사. 손상·모호한 입력과 보호 파일 변경은 전체 deny. lessons/evidence/lifecycle 등 권위 상태와 LESSONS_DIR 기본 보호 |
| `tools/loop-engine/runtime/{capabilities.json,hook-adapter.mjs}`, `bin/runtime-doctor.mjs` | 공통 core와 호스트 기능 분리. PreToolUse의 malformed/nondecision stdout deny, 빈 stdout defer. ask는 계속 deny이며 별도 승인만으로 동일 retry가 통과하지 않음 |
| `scripts/{generate-runtime-packages.mjs,runtime-docs.mjs,refresh-skill-lock.mjs}` | 재현 가능한 Claude/Codex 패키지, 출처 hash·버전·mode inventory, 엄격한 문서 링크 검사, 로컬 hash-only lock 갱신 |
| `.claude-plugin/marketplace.json`, 각 플러그인 `.claude-plugin/plugin.json`, `skills-lock.json` | engine 0.15.0 / ship-flow 0.11.0 / memory 0.7.0, engine 의존성 ^0.15.0. 이전 파생 설치본은 재라벨링하지 않음 |
| `tools/loop-engine/bin/*.mjs` 실행 mode | 기존 누락 executable bit 보정. 새 `agent-eval.mjs`, `evidence.mjs`도 CI에서 mode와 직접 실행을 검사 |
| `.github/workflows/{runtime-packages,loop-engine-test,loop-memory-test,tag-on-publish,gitleaks}.yml` | OS/Node matrix, schema canary, committed dist drift, 동일 event SHA 검증 뒤 tag 작업. 실행한 릴리스는 없음 |
| `tools/ship-flow/templates/setup-loop-engine.action.yml.template` | 호출별 mktemp, 개별 버전 pin, 검증 후 경로 export, 실패 시 해당 임시 경로만 정리 |
| `CODEOWNERS`, `README.md`, `docs/runtime-compatibility.md`, `.gitignore` | 외부 신뢰 경로 확대, 호환성/설치 drift/allowlist/liveness/승인 경계 설명, 생성물 build 경로 제외 |
| `tools/loop-engine/test/{plugin-path,apply-patch-runtime,runtime-packages}.test.{mjs,sh}` | 실제 subprocess·임시 git/worktree·생성 artifact 기반 회귀. 기존 shell runner 참여 유지 |

역할 skill의 링크는 실제 `skills/<role>/` 위치에 맞춰 재작성한다. 소비자 `.codex/agents/`로 옮기는
TOML에는 공통 AUTHORIZATION과 publisher handoff 등 필요한 Markdown 자원을 내장한다. 읽기 전용
sandbox가 `/tmp` 쓰기를 보장한다고 주장하지 않는다. 호스트가 허용한 임시 fixture만 사용한다.
Native Workflow JS가 없어도 skill이 문서화한 fallback은 허용하며, 필수 독립성·gate를 충족하지
못하는 단계만 blocked/incomplete로 보고하고 별도 승인된 독립 작업을 계속한다.

## 확인 결과

- 최종 포팅 Node suite: **29/29 PASS** (resolver 8, patch 보호 10, packaging/adapter 11).
- 엔진 `run.sh`에서 추출한 실제 frozen-entry loader로 세 wrapper **29/29 PASS**.
  wrapper를 변경하거나 NODE_OPTIONS 계약을 약화하지 않았다. 새 CLI의 실제 usage 종료 코드도 검사한다.
- 추가 P1 보호 누락: `.loop/lessons/**`, `LOOP_DIR/lessons/**`, 실제 `LESSONS_DIR` override의
  직접 Write/Edit/MultiEdit 및 apply_patch를 차단한다. default와 custom 경로를 함께 유지하고
  physical alias도 검사한다. 별도 `LOOP_LESSONS` registry는 없다. 정상 lessons CLI를 Bash로
  호출하면 defer이며 실제 임시 미검증 lesson 생성까지 확인했다. 별도 CLI `--lessons` flag나
  Bash 내부 env assignment는 다음 hook에 전달되는 registry가 아니다. 사용자 custom 경로는
  hook 환경의 `LESSONS_DIR` 또는 protect globs로 전달해야 한다. unrestricted Bash를 막는
  attestation이 아니며, backing receipt/lifecycle 검증은 메모리 lane이 별도로 맡는다.
- 기존 `main-detection-guard.test.sh`, `codeowners-indirection.test.sh`: **PASS**.
  resolver symlink가 출력 없이 exit 0이던 결함을 실제 재현한 뒤 수정했다. 기존 main assertion은
  그대로다. 직접·상대·공백/한글·symlink·preserve-symlinks-main·단순 import를 검증한다.
- lessons 보호 추가 뒤 기존 `protect-worktree-root` 19건, `protect-globs-matcher` 14건,
  `guard-bypass-and-leak` 회귀 모두 PASS. arming/guard-off 및 기존 보호 assertion을 유지했다.
- 새 CODEOWNERS 경로 4종은 임시 Git 저장소에서 **변경하지 않은 pinned runner**를 호출해,
  외부 구현 약화가 실제 base test 실패로 검출되는지 확인했다. 기존 engine 전체 보호를 유지한다.
- 패키지 생성 및 `--check`, skill-lock `--check`: PASS인 소스 snapshot 확인.
  동시에 다른 lane이 소스를 갱신하면 `--check`는 drift를 보고한다. 마지막 전체 편집 후 재생성한다.
- Claude Code **2.1.229**: 임시 HOME/config에서 source catalog+3 plugin, generated catalog+3 plugin
  총 **8개 대상 `plugin validate --strict` PASS**.
- Codex CLI **0.146.0**: top/plugin/marketplace help에 manifest validate 명령 없음.
  비어 있는 임시 CODEX_HOME의 features 결과 hooks/multi_agent/plugins stable true,
  plugin_hooks removed false. 실제 설치·활성화·trust 증거가 아니다.
- 별도 로컬 Codex plugin schema validator: 생성 플러그인 **3/3 PASS**. 생성 role TOML **5/5 parse**.
  첫 보조검증은 임시 디렉터리/Python yaml 경로 문제로 실패했고, 빈 CODEX_HOME을 만든 뒤 기존
  로컬 yaml 경로를 명시하여 재실행했다. 설치는 하지 않았다.
- 변경 파일 whitespace 검사 PASS. 전체 엔진/메모리 통합 suite와 hosted CI 실행은 부모 lane 소관이다.

이전 resolver shell assertion의 이전/유지 매핑과 검증이 추가되며 의도적으로 바뀐 contract는
[호환성 문서](../runtime-compatibility.md#resolver-regression-migration-self-review)에 기록했다.
기존 존재하지 않는 `/cache/...` 반환 fixture만 실제 manifest fixture로 바꾸고, 해당 경로를 이제
거부하는 음성 사례를 추가했다. assertion 삭제로 잘못된 동작을 통과시키지 않았다.

## 독립 메모리 교차 검토: 재현 및 수정 확인 1건

**P1 — 잠금 전에 읽은 오래된 source snapshot이 완료된 철회를 되돌린다.**

`tools/loop-memory/src/lessons.ts:228`에서 source를 읽고, 다음 줄의 `pool.connect()` 이후에야
advisory lock을 얻는다. `knowledge.ts:287`의 sync도 호출자가 잠금 전에 파싱한 desired snapshot을
받는다. 먼저 시작한 A가 connection 획득 전에 지연되면 새 상태를 읽은 B가 먼저 철회를 완료하고,
이후 A가 잠금을 획득해 철회된 내용을 다시 서명·삽입할 수 있다.

재현은 production graduate/recall/store/provenance 함수, 기존 relational fixtureStore,
stubEmbedder와 임시 source 파일을 사용했다. 첫 `pool.connect`에 barrier를 두어 순서를 고정했다.
실제 DB/API/설치본은 사용하지 않았다.

| 경로 | B 최신 snapshot 완료 | A 이전 snapshot 재개 |
|---|---|---|
| lesson active → invalid_at | purged 1, recall 0 | added 1, recall 1 |
| ADR Accepted → Superseded | deleted 1, recall 0 | added 1, recall 1 |

제안: source snapshot 생성까지 동일 corpus 잠금 안으로 이동한다. knowledge의 source reader는
잠금 후 호출할 수 있는 방식으로 전달하거나 snapshot revision을 재검증하고 오래된 호출을 거부한다.
두 순서 역전 사례를 회귀에 추가한다. 이 교차 검토는 읽기 전용이며 메모리 구현은 수정하지 않았다.
본 문서의 재현 시점 이후 메모리 lane이 수정할 수 있으므로 부모가 최종 상태를 확인한다.

**2026-09-05 12:03:39 UTC committed-source 재검증: 두 경로 모두 PASS, 위 P1 수정 확인.**
대상 커밋은 `b4ed9d56a4dfc21affdaf7f85700496487a360da`이며 실행 전후 HEAD가 일치했다.
lesson source 읽기는 잠금 안으로 이동했고, knowledge filesystem adapter는 잠금 안에서 실행할
desiredSource callback을 전달한다. 기존 caller-array API에 외부 source freshness를 주장하지 않는다.

| 패치 후 재현 | 초기 정상 recall | 최신 철회 완료 후 | 지연된 이전 호출 재개 후 |
|---|---:|---:|---:|
| 실제 backing PASS/FAIL/seal 파일을 가진 lesson | 1 | 0 (purged 1) | 0 (added 0) |
| Accepted → Superseded ADR | 1 | 0 (deleted 1) | 0 (added 0) |

초기 lesson은 현재 production reader의 backing 검증도 통과했다. 초기부터 제외되는 옛 fixture로
통과시킨 것이 아니다. 두 첫 pool.connect barrier 재현만 실행했으며 broad scan/전체 suite는 하지 않았다.
관련 production/helper 14개 파일의 실행 전후 SHA256 및 해당 커밋의 파일 내용이 모두 일치했다.
검증 snapshot의 lessons.ts는
`468bb522968aa1124cf3e28e78ae1a4303d27c8997b0582355390f6a71531e50`, knowledge.ts는
`0e1701d4f51749a85f3bda5a211f92d91af9509bc5d41772a2001f7b045a0177`이다.
로컬 실행 코드와 전체 hash/result는 `.loop/hardening-validation/memory-snapshot-race-recheck.mjs` 및
동명의 `.json`에 보관했다. 이번에는 요청된 두 scratch 재현만 실행하고 이 보고서의 상태만 갱신했다.
production/test source 변경, broad scan, 실제 DB/API/native 세션 호출은 없었다.

## 남는 경계

Native hook trust/deny enforcement, fresh subagent isolation, Stop 동작과 hard cancellation은 실제
호스트 세션으로 확인하지 않았다. schema/fixture/agent-eval dataset 성공을 native E2E로 표시하지
않는다. CI는 Linux/macOS × Node 22/24와 Claude 2.1.261/latest 검사를 정의했지만 hosted 실행은 남아 있다.
CODEOWNERS 확대는 이 파일이 **다음 review의 base**가 된 뒤 적용된다. 기존 runner는 engine suite만
pin하므로 새 메모리 기능 전체의 과거 baseline이나 원격 required check를 만들어 주지 않는다.
