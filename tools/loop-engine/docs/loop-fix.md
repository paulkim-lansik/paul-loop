# loop-fix 실행 계약

`bin/loop-fix.sh`는 검증 → 수정 → 재검증을 수행하는 로컬 inner loop다. Node supervisor가 실행의 소유권·절대 마감·취소·재개 상태를 관리하고, Bash 3.2 worker가 검증과 수정 명령을 실행한다. 실제 모델 호출 여부는 호출자가 전달한 `--fix` 명령에 달려 있다.

```sh
tools/loop-engine/bin/loop-fix.sh \
  --verify 'pnpm verify' --fix 'sh tools/fix-from-stdin.sh' \
  --protect 'tools/verify/**/*.sh' --protect '**/*.test.ts' \
  --max-iter 5 --infra-retries 2 --budget-sec 600
```

`--verify`는 필수다. `--fix`를 생략하면 검증만 수행한다. 수정 명령에는 실패 블록·로그 위치·해당 실패에 대한 기존 교훈을 표준 입력으로 전달한다. 검증 명령은 항상 `verdict-run.sh`를 거친다. 검증 출력과 wrapper exit의 의미는 [verdict 계약](verdict-contract.md)을 따른다.

## 예산과 재시도

| 옵션 | 기본값 | 계약 |
| --- | --- | --- |
| `--max-iter` | `10` | 제품 검증 회차 한도. 명령을 보내기 전에 회차와 attempt를 저장한다. |
| `--budget-sec` | `0` | `0`은 총 시간 제한 없음. 양수는 최초 실행에서 한 번 정한 절대 마감이며 검증·수정·재시도·재개 대기 시간을 모두 포함한다. |
| `--stall` | `3` | 실패 fingerprint와 결과 카운트가 함께 진전하지 않은 연속 회차 한도. |
| `--infra-retries` | `2` | 인식된 일시적 인프라 실패에 대한 추가 재시도 한도. `off`는 인프라 면제 분류를 끈다. |
| `--idle-timeout-sec` | `0` | 로그 활동이 없는 명령을 중단하는 보조 watchdog. |
| `--progress-timeout-sec` | `0` | 검증 결과 진전이 없는 명령을 중단하는 보조 watchdog. |

인프라 실패는 제품 회차를 면제할 수 있지만 실제 검증 호출 수인 `attempt`와 누적 `infra_count`를 되돌리지 않는다. 중단 시점에 이미 예약한 검증 호출도 소비한 것으로 남는다. `--resume`은 stall 상태와 retry 소비량을 보존한다.

총 예산은 실행 중인 명령에도 적용한다. 마감 뒤에 도착한 PASS는 성공으로 반환하지 않는다. 로그 출력이나 `verdict.passed` 형태의 원장 행을 계속 추가해도 절대 마감이 연장되지 않는다. 프로세스 종료 확인과 보호 파일 복구에는 마감 뒤 짧은 정리 시간이 추가될 수 있다.

progress watchdog은 생산자와 동일한 `lib/run-ledger.mjs` resolver로 세션 원장을 찾는다. 연결된 worktree에서 실행해도 해당 세션의 main-worktree 원장을 읽을 수 있다. 원장은 관측 자료이며 lifecycle의 권위 있는 예산·소유권·상태를 갱신하지 않는다. `LOOP_RUN_LEDGER`는 명시적인 원장 경로 override다.

## 실행 소유권과 저장 위치

물리적인 Git worktree 루트에 `.loop/lifecycle/<run_id>.json`을 저장한다. Git 저장소 밖에서는 실행 디렉터리가 루트다. 각 JSON은 임시 파일 쓰기·fsync·rename으로 교체한다.

| 필드 | 의미 |
| --- | --- |
| `schema_version`, `run_id` | 현재 버전은 `1`; 실행마다 생성한 UUID. |
| `owner` | supervisor `pid`, worker process-group leader `worker_pid`, 소유권 `token`. |
| `attempt`, `iteration`, `infra_count`, `stall_count` | 예약한 호출 수, 제품 회차, 인프라 실패 수, stall 누적. |
| `started_at`, `deadline_at` | 최초 시작과 절대 마감. 총 제한이 없으면 마감은 `null`. |
| `target_hash`, `config_hash` | 최초 실행 대상과 명령·한도·알려진 설정의 불변 식별자. |
| `status`, `phase` | 실행 상태와 마지막 저장 지점(`verify`, `verified`, `infra-retry`, `failed`, `fix` 등). |
| `loop_dir`, `protected`, `owned_sentinels` | handoff 경로, 보호 baseline과 복구 사본, 이 실행이 직접 만든 sentinel. |
| `evidence` | 이 실행·attempt에 실제로 귀속된 verification receipt ID 목록. |

`.loop/lifecycle/lease`와 `<loop-dir>/.execution-lease`를 각각 독점한다. 동일 worktree에서 서로 다른 `--loop-dir`을 지정해도 두 loop가 동시에 실행되지 않는다. 서로 다른 worktree라도 동일 handoff 디렉터리를 공유하면 거부한다. 별도 worktree와 별도 handoff 디렉터리는 독립적으로 실행할 수 있다.

이 lease는 `loop-fix` 실행끼리의 충돌을 막는다. 다른 프로그램의 임의 쓰기를 잠그는 파일시스템 격리는 아니다. 원장 공유와 workspace 소유권은 별개다.

`--loop-dir` 기본값은 `.loop`이며 로그·verdict·수정 프롬프트·receipt를 둔다. custom 경로를 쓰더라도 lifecycle과 Stop 상태의 기준은 물리적 worktree 루트다. 성공 시 verdict 생산자의 전체 상태를 canonical `.loop/verdict-state.json`에 반영한다. 실패·취소 때에는 두 위치의 PASS를 무효화한다.

## 명시적인 재개

취소되거나 중단된 실행의 UUID는 `.loop/lifecycle/`의 JSON 파일명에서 확인한다. 같은 실행 디렉터리에서 다음처럼 재개한다.

```sh
tools/loop-engine/bin/loop-fix.sh --resume <run_id>
```

이 명령 자체가 재개 의사 표시다. 추가 승인 질문은 없다. 다른 옵션을 생략하면 저장된 원래 argv를 그대로 쓴다. 옵션을 함께 주면 파싱된 전체 설정이 원래와 같아야 한다. `--resume`으로 명령이나 예산을 바꿀 수 없다.

재개에는 다음 조건이 필요하다.

- 상태가 `running`, `cancelled`, `interrupted` 중 하나이고 이전 supervisor와 worker process group이 모두 종료되어 있어야 한다.
- 실행 경로·물리적 worktree 루트·HEAD로 계산한 원래 `target_hash`가 같아야 한다. fixer가 변경할 수 있는 일반 소스의 미커밋 내용 전체를 고정하는 것은 아니다.
- 원래 명령·플래그·한도와 worker 스크립트 내용이 같아야 한다. 실행 경로 및 루트의 `.claude/ship-flow.config.json`, `risk-rules.json`, `package.json`, 주요 lockfile, `.loop/protect.globs`의 존재 여부와 내용도 같아야 한다.
- 보호 baseline의 경로와 바이트가 같아야 한다. shell 명령이 간접 참조하는 모든 설정을 자동 추론하지 않으므로 추가 검증 스크립트·설정은 `--protect`로 명시한다.
- 상태 JSON이 유효해야 한다. 손상된 상태를 초기 카운터로 덮어쓰거나 새 실행으로 가장하여 재개하지 않는다.

재개는 새 검증을 예약한다. 이전 PASS를 재사용하거나 중단된 fixer를 그대로 재실행하지 않는다. 최초 시작 시각과 마감, 기존 attempt·회차·retry·stall 수치는 유지된다. 대기 중 마감이 지났으면 새 명령 없이 `exhausted`로 끝난다. `succeeded`, `failed`, `exhausted`, `protected_violation`, `incomplete`는 terminal이며 같은 ID로 재개할 수 없다. 별도의 새 실행은 새 예산을 갖는 명시적인 새 작업이다.

## 취소, 보호, Stop

SIGINT/SIGTERM을 받으면 supervisor는 PASS를 먼저 무효화하고 worker process group에 TERM, 이어 필요하면 KILL을 보낸다. worker shell이 먼저 끝나도 남은 같은 그룹의 자식들을 종료·확인한 뒤 보호 파일을 복구한다. 이 실행이 만든 sentinel과 lease는 그 이후에만 해제한다. 기존 수동 sentinel은 유지한다. 그룹이 남아 있다고 판단되면 lease와 sentinel을 보존하고 점검을 요구한다.

supervisor 자체를 SIGKILL하면 정리 코드를 실행할 수 없다. stale lease는 의도적으로 남는다. 살아 있는 worker가 있으면 `--resume`도 거부한다. 실행 소유권의 PID를 확인하여 해당 worker가 종료된 뒤에만 명시적으로 재개한다. 무작정 잠금 디렉터리를 지우는 방식은 지원하지 않는다.

`--protect`는 hook과 같은 glob matcher를 사용한다. `**/*.test.sh`는 루트의 `example.test.sh`와 하위 디렉터리 파일을 모두 포함한다. 각 패턴이 최소 한 파일에 매치해야 하며 하나라도 0건이면 검증을 시작하지 않는다. `.git`, `node_modules`, 운영용 `.loop` 및 handoff 디렉터리는 스캔에서 제외한다. 보호 baseline의 symlink, 실행 디렉터리 밖 경로, 줄바꿈을 포함한 경로는 거부한다.

보호 파일 위반은 복구 후에도 실패다. 백업이 손상되거나 안전하게 복구하지 못하면 `protect-compromised`를 남기며, 점검 전 후속 실행을 거부한다. 같은 사용자 권한의 임의 명령, 새 세션으로 의도적으로 탈출한 프로세스, 실행 중 변조 후 원상복구까지 봉쇄하는 보안 sandbox는 아니다. 서버 측 보호와 승인 경계는 그대로 별도다.

복원하기 전 파일과 모든 상위 경로를 검사한다. symlink로 바뀐 경로는 바이트가 baseline과 같더라도 건너뛰어 성공으로 취급하거나 링크를 따라 쓰지 않고 `protect-compromised`를 남긴다. supervisor는 자식 process group을 종료한 뒤 보호 glob 전체를 다시 열거한다. worker의 마지막 검사 이후 생긴 새 매치도 위반으로 처리하고, 실패 상태를 저장하기 전에 해당 범위의 새 파일을 정리한다.

Stop hook은 payload의 `cwd`가 같은 Git common directory에 속하는지 확인한 후 실제 worktree의 sentinel·verdict를 판단한다. 다른 worktree의 PASS를 빌릴 수 없다. lifecycle lease가 남아 있으면 중간 검증의 PASS로 loop 완료를 판정하지 않는다. 기존 Stop의 명시적 비활성화와 반복 차단 탈출 정책은 바꾸지 않는다.

별도의 feature worktree 생성 gate는 요청을 `.loop/worktree-gate.<session>.json`의 `pending`으로 기록한다. 다음 Bash PreToolUse에서 `git worktree list --porcelain -z`에 요청했던 repository·branch·물리적 path가 실제로 나타났을 때만 `confirmed`로 옮긴다. 요청 전부터 존재한 worktree, 브랜치 이름만 일치하는 다른 경로, 임의 `tool_response.success`는 성공 증거가 아니다. 실패한 최초 생성은 확인된 슬롯을 소비하지 않고, 아직 실행되지 않은 두 번째 요청은 재시도마다 계속 승인 질문을 낸다. 실제 생성된 두 번째 worktree도 이후 Git 관측으로만 확인한다.

이 gate의 schema v2에서 `branches`는 confirmed만 반영하는 호환 필드다. 과거 attempts-only `branches`는 경로 증거가 없으므로 `legacy_unconfirmed`로 보존하고 자동 승격하지 않는다. 확인한 repository·branch는 worktree가 나중에 삭제되어도 같은 세션의 이력으로 유지한다. pending의 `requires_approval`은 질문이 필요했다는 메타데이터이며 승인 완료를 뜻하지 않는다. 관측만으로 생성 주체의 신원이나 승인 여부를 증명하지 않으며, 아직 관측되지 않은 동시 최초 요청들을 직렬화하지도 않는다. 기존 session·project 격리, 비-feature 면제, 명시적 kill switch와 best-effort 로컬 상태 계약은 유지한다.

| 종료 코드 | 의미 |
| --- | --- |
| `0` | 검증과 보호 검사 후 loop 성공. |
| `1` | 검증 실패, stall, 반복·인프라·시간 예산 소진, watchdog 중단. |
| `2` | 사용법·대상/설정 불일치·lease 충돌·저장 상태 문제 등 실행 거부. |
| `3` | 보호 파일 위반. |
| `4` | 기존 `protect-compromised` 때문에 실행 거부. |
| `130` | SIGINT/SIGTERM 취소. |

## Receipt, 학습, outer loop의 경계

worker는 `LOOP_RUN_ID`와 예약한 `LOOP_ATTEMPT`를 `verdict-run`에 전달한다. verdict 생산자는 명령·대상·시각·실제 verdict 출력에 결합된 verification receipt를 기록한다. lifecycle은 `verdict-state.json.receipt_id`를 읽되 같은 run/attempt, gate mode, verdict/exit인지 확인한 뒤 `evidence`에 추가한다. ID의 실제 파일은 `<loop-dir>/evidence/<id>.json`이다.

완료된 검증의 receipt 체크포인트는 필수다. 저장 실패·누락·불일치는 오류를 표시하고 exit `2`, `incomplete`로 종료하며 성공 상태를 남기지 않는다. supervisor도 자식 종료 후 현재 run/attempt의 PASS receipt와 저장된 체크포인트를 다시 확인한다. 이는 개별 `verdict-run`의 best-effort 상태 저장보다 엄격한 loop 완료 계약이며, 중간 PASS만으로 sentinel을 해제하지 않는다. 래퍼 자체가 실행 전 exit `2`로 거부한 경우에는 receipt가 없는 `verifier-error` 단계로 기록해 원래 오류 사유를 보존한다.

`--lessons` 사용 시 최초의 완료된 코드 FAIL과 그 receipt 경로를 함께 보존한다. 이후 PASS의 receipt와 최초 FAIL receipt를 `lessons record --verified`에 넘긴다. `mark-clean`도 실제 PASS receipt를 요구한다. receipt가 없거나 불일치하면 학습 갱신을 거부하고 `lessons.err`에 사유를 남긴다. 검증 결과를 임의의 verified 교훈으로 대체하지 않는다. 첫 검증 도중 취소·마감이 발생해 완성된 FAIL이 없으면 fail-channel 교훈을 만들지 않는다.

verification receipt는 특정 명령의 관측 결과이고, lifecycle은 한 inner-loop 실행의 현재 상태다. `evidence`에 PASS receipt가 있어도 이후 취소·보호 위반으로 loop 전체가 실패할 수 있다. 소비자는 lifecycle terminal 상태와 receipt의 현재 유효성을 함께 봐야 한다.

요구사항·AC·검토·승인·배포를 잇는 outer-loop progression은 이 worker의 책임이 아니다. [retired orchestrator](orchestrate.md)를 다시 실행기로 사용하지 않는다. 원장 행이나 receipt를 기록하는 행위는 사람의 승인·게시·원격 변경 권한을 생성하지 않는다.

## 집중 회귀 검증

`test/loop-lifecycle.test.sh`는 임시 로컬 fixture만 사용하여 glob, 연결 worktree Stop, 승인 재시도, 독점 lease, descendant 취소, 절대 마감, 재개 시 budget 보존, 원장 resolver, receipt 연결을 검증한다. `loop-fix-protect.test.sh`, `loop-fix-infra-exempt.test.sh`, `loop-fix-progress-clock.test.sh`, `loop-fix-fail-channel.test.sh`, `auto-arm.test.sh`가 기존 동작과의 회귀 경계를 보완한다. 실제 모델 API나 원격 저장소 변경 없이 실행할 수 있다.
