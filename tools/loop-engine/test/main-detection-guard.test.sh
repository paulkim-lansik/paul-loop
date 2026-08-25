#!/usr/bin/env bash
# BAC-792 — "이 파일이 직접 실행됐나?" 판정 관용구가 조용히 틀리는 걸 막는다.
#
# 관용구는 하나뿐이어야 한다:
#     if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) { … }
#
# 왜 `file://${process.argv[1]}`가 아닌가 (실측, 이 회차):
#   `import.meta.url`은 percent-encoding된다(공백·비ASCII → %XX). 템플릿 문자열은 raw OS 경로를 넣어
#   두 값이 어긋난다. 그러면 CLI 블록이 통째로 실행되지 않고 **출력 0줄에 exit 0**이 된다 — 호출자
#   (verdict / require-tests.sh / CI)는 그걸 "게이트 통과"로 읽는다. 같은 파일을 공백 있는 디렉터리에
#   두면 `check-module-size.mjs`가 `PASS: …` 한 줄조차 없이 exit 0으로 끝났다. 래칫이 조용히 없어진다.
#
# 왜 앞의 `process.argv[1] &&`인가:
#   argv[1]이 없는 맥락(`node -e`, 워커, ESM 로더)에서 pathToFileURL(undefined)는 던진다. 게이트와
#   리졸버는 어떤 맥락에서도 **import만으로 죽으면 안 된다**.
#
# 이 테스트는 텍스트 검사와 행위 검사를 둘 다 한다. 텍스트만 보면 관용구를 지키면서 다르게 깨진
# 구현을 놓치고, 행위만 보면 공백 없는 CI 경로에서 늘 통과해 애초에 이 버그를 못 잡는다.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ENGINE="$(cd "$HERE/.." && pwd)"

fail() { echo "FAIL: $1"; exit 1; }

# ── A. 텍스트: 관용구를 쓰는 모든 .mjs가 가드와 pathToFileURL을 함께 쓴다 ────────────────────
found=0
while IFS= read -r hit; do
  [ -n "$hit" ] || continue
  found=$((found + 1))
  file="${hit%%:*}"
  line="${hit#*:}"; line="${line#*:}"
  case "$line" in
    *'`file://${process.argv[1]}`'*)
      fail "$file: main 감지에 템플릿 문자열을 쓴다 — 경로에 공백/비ASCII가 있으면 CLI 블록이 조용히 안 돌고 exit 0이 된다. pathToFileURL(process.argv[1]).href 로 바꿀 것" ;;
  esac
  case "$line" in
    *'process.argv[1] &&'*) : ;;
    *) fail "$file: main 감지에 argv[1] 가드가 없다 — argv[1]이 없는 맥락(node -e, 워커)에서 import만으로 던진다" ;;
  esac
  case "$line" in
    *'pathToFileURL(process.argv[1]).href'*) : ;;
    *) fail "$file: main 감지가 pathToFileURL로 정규화하지 않는다" ;;
  esac
done < <(grep -rn 'import\.meta\.url ===' "$ENGINE" --include='*.mjs' 2>/dev/null || true)

# 하나도 못 찾았다면 grep이 실패한 것이지 "전부 통과"가 아니다. 이 구분이 없으면 이 테스트는
# 파일 배치가 바뀌는 순간 조용히 아무것도 검사하지 않게 된다.
[ "$found" -ge 1 ] || fail "main 감지 관용구를 하나도 찾지 못했다 — grep 대상($ENGINE)이 바뀌었는지 확인할 것. 검사가 vacuous해졌다"

# ── B. 행위: 공백 있는 경로에서 실제로 CLI 블록이 도는가 ────────────────────────────────────
SANDBOX="$(mktemp -d)" || fail "mktemp -d failed"
trap 'rm -rf "$SANDBOX"' EXIT
SPACED="$SANDBOX/a dir with spaces"
mkdir -p "$SPACED" || fail "cannot create spaced dir"

# 자기 완결적(상대 import 없음)이라 복사만으로 도는 bin만 고른다.
BIN="$ENGINE/bin/check-module-size.mjs"
[ -f "$BIN" ] || fail "check-module-size.mjs not found at $BIN"
cp "$BIN" "$SPACED/" || fail "copy failed"

OUT="$(cd "$SPACED" && node "./check-module-size.mjs" 2>&1)"
if [ -z "$OUT" ]; then
  fail "공백 있는 경로에서 실행했더니 출력이 0줄이다 — CLI 블록이 안 돌았고 exit 0만 남았다. 호출자는 이걸 '게이트 통과'로 읽는다"
fi

# 대조군: 공백 없는 경로에서도 같은 종류의 출력이 나와야 한다(둘 다 조용하면 위 검사가 무의미).
PLAIN="$SANDBOX/plain"
mkdir -p "$PLAIN" && cp "$BIN" "$PLAIN/"
OUT2="$(cd "$PLAIN" && node "./check-module-size.mjs" 2>&1)"
[ -n "$OUT2" ] || fail "공백 없는 경로에서도 출력이 없다 — 대조군이 성립하지 않아 B가 아무것도 증명하지 못한다"

# ── C. import만으로 죽지 않는가 (argv[1]이 없는 맥락) ───────────────────────────────────────
for m in bin/check-module-size.mjs bin/check-pr-hygiene.mjs bin/plugin-path.mjs lib/sanitize.mjs; do
  [ -f "$ENGINE/$m" ] || continue
  node -e "import('$ENGINE/$m').then(()=>process.exit(0)).catch((e)=>{console.error(e.message);process.exit(1)})" >/dev/null 2>&1 \
    || fail "$m: argv[1]이 없는 맥락에서 import만으로 죽는다 — 게이트/리졸버는 어떤 맥락에서도 로드 가능해야 한다"
done

echo "PASS: main-detection guard — ${found}개 관용구 전부 pathToFileURL+argv[1] 가드, 공백 경로에서 CLI 실제 실행, argv[1] 없는 맥락에서 import 안전"
