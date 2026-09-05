#!/usr/bin/env bash
# Regression test for ship-flow/workflows/adversarial-review.js의 검증 팬아웃 상한.
#
# 왜: 총 에이전트 = domains + VOTES_PER_FINDING × findings + 1 인데 finder의 findings 배열에
# 상한이 없었다. 한 도메인이 20건을 내면 그 도메인만으로 60개의 검증 에이전트가 뜬다 — 워크플로
# 저작 레퍼런스가 스스로 고지하는 규모를 한참 넘고, 같은 레퍼런스의 "no silent caps"(커버리지를
# 자르면 log로 무엇이 빠졌는지 밝힐 것) 규약도 어긴다.
#
# 잠그는 계약:
#   ① 도메인당 검증 팬아웃이 상한을 넘지 않는다(에이전트 수를 실제로 세서 확인 — 상수 존재 여부가
#      아니라 행위를 잰다).
#   ② 잘린 findings는 버려지지 않고 unverifiedOverCap으로 반환된다(침묵 절단 금지).
#   ③ 잘렸다는 사실이 log()로 드러난다.
#   ④ 잘리는 순서는 severity — blocker가 minor 때문에 검증에서 밀려나지 않는다.
#   ⑤ 반박 투표는 저가 모델/저 effort로 라우팅되지 않는다(verifier=ceiling — 검증의 *양*은 묶되
#      *질*은 절대 깎지 않는다. 비용 절감이 이 원칙을 침식하는 걸 게이트로 막는다).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$HERE/../../.."
WF="$ROOT/tools/ship-flow/workflows/adversarial-review.js"

fail() { echo "FAIL: $1"; exit 1; }
[ -f "$WF" ] || fail "adversarial-review.js not found at $WF"

# 실제 파일을 스텁 하네스로 실행한다 — 로직을 복사하면 복사본만 통과하는 가짜 green이 된다.
node -e '
const fs = require("node:fs");
const src = fs.readFileSync(process.argv[1], "utf8").replace(/^export const meta/m, "const meta");

const FINDINGS_PER_DOMAIN = 20;
const CAP = 8;               // adversarial-review.js의 DEFAULT_MAX_VERIFIED_PER_DOMAIN
const VOTES = 3;             // VOTES_PER_FINDING

const calls = { find: 0, verify: 0, other: 0 };
const logs = [];
const verifyOpts = [];

async function agent(prompt, opts = {}) {
  const phase = opts.phase || "";
  if (phase === "Find") {
    calls.find++;
    // severity를 섞어서 준다 — minor가 앞줄에 오도록 배치해 정렬이 실제로 일어나는지 본다.
    const findings = Array.from({ length: FINDINGS_PER_DOMAIN }, (_, i) => ({
      title: `f${i}`,
      detail: "d",
      file: "x.ts",
      severity: i < 15 ? "minor" : "blocker",
    }));
    return { findings };
  }
  if (phase === "Verify") {
    calls.verify++;
    verifyOpts.push(opts);
    return { status: "confirmed", reason: "reproduced", evidence: "read x.ts and ran fixture" };
  }
  calls.other++;
  return "text";
}
const parallel = (thunks) => Promise.all(thunks.map((t) => t()));
async function pipeline(items, ...stages) {
  return Promise.all(items.map(async (item, i) => {
    let acc = item;
    for (const s of stages) acc = await s(acc, item, i);
    return acc;
  }));
}
const phase = () => {};
const log = (m) => logs.push(String(m));

const AsyncFn = Object.getPrototypeOf(async function () {}).constructor;
const fn = new AsyncFn("args", "agent", "parallel", "pipeline", "phase", "log", src);
const args = { target: "t", domains: [{ key: "alpha", prompt: "p" }] };

fn(args, agent, parallel, pipeline, phase, log).then((res) => {
  // ① 팬아웃 상한이 실제로 작동한다
  const expected = CAP * VOTES;
  const uncapped = FINDINGS_PER_DOMAIN * VOTES;
  if (calls.verify !== expected) {
    throw new Error(`verify fan-out must be capped at ${expected} (cap ${CAP} x ${VOTES} votes), got ${calls.verify} (uncapped would be ${uncapped})`);
  }
  // ② 잘린 것은 버려지지 않는다
  const over = res.unverifiedOverCap || [];
  if (over.length !== FINDINGS_PER_DOMAIN - CAP) {
    throw new Error(`unverifiedOverCap must carry the ${FINDINGS_PER_DOMAIN - CAP} dropped findings, got ${over.length}`);
  }
  if (over.some((f) => f.severity === "blocker")) {
    throw new Error("a blocker must never be the thing dropped while minors get verified");
  }
  // ③ 침묵 절단 금지
  if (!logs.some((l) => l.includes("cap") || l.includes("unverified"))) {
    throw new Error("a truncated run must log() what it dropped, got logs: " + JSON.stringify(logs));
  }
  // ④ severity 우선순위 — blocker 5건이 전부 검증 대상에 들어가야 한다
  const confirmedTitles = new Set((res.confirmed || []).map((f) => f.title));
  const blockers = Array.from({ length: 5 }, (_, i) => `f${15 + i}`);
  for (const b of blockers) {
    if (!confirmedTitles.has(b)) throw new Error(`blocker ${b} must be verified ahead of minors`);
  }
  // ⑤ verifier=ceiling — 반박 투표를 싸게 만들지 않는다
  for (const o of verifyOpts) {
    if (o.model) throw new Error("refutation votes must not pin a model — the verifier is the ceiling, never the place to save tokens");
    if (o.effort && o.effort === "low") throw new Error("refutation votes must not drop to low effort");
  }
  console.log("ok");
}).catch((e) => { console.error(e.message); process.exit(1); });
' "$WF" || fail "adversarial-review fan-out contract broken"
echo "PASS: verification fan-out is capped per domain, drops are severity-ordered, carried, and logged; votes stay full-strength"

# 상한 상향 경로가 살아 있는지 — 의도적 전수 실행을 막아서는 안 된다
node -e '
const fs = require("node:fs");
const src = fs.readFileSync(process.argv[1], "utf8").replace(/^export const meta/m, "const meta");
let verify = 0;
async function agent(prompt, opts = {}) {
  if (opts.phase === "Find") return { findings: Array.from({ length: 12 }, (_, i) => ({ title: `f${i}`, detail: "d", severity: "major" })) };
  if (opts.phase === "Verify") { verify++; return { status: "confirmed", reason: "reproduced", evidence: "read x.ts and ran fixture" }; }
  return "text";
}
const parallel = (t) => Promise.all(t.map((x) => x()));
async function pipeline(items, ...stages) {
  return Promise.all(items.map(async (item, i) => { let a = item; for (const s of stages) a = await s(a, item, i); return a; }));
}
const AsyncFn = Object.getPrototypeOf(async function () {}).constructor;
const fn = new AsyncFn("args", "agent", "parallel", "pipeline", "phase", "log", src);
fn({ target: "t", domains: [{ key: "a", prompt: "p" }], maxVerifiedPerDomain: 12 }, agent, parallel, pipeline, () => {}, () => {}).then((res) => {
  if (verify !== 36) throw new Error("args.maxVerifiedPerDomain=12 must verify all 12 findings (36 votes), got " + verify);
  if ((res.unverifiedOverCap || []).length !== 0) throw new Error("nothing should be over the cap when it is raised to fit");
  console.log("ok");
}).catch((e) => { console.error(e.message); process.exit(1); });
' "$WF" || fail "args.maxVerifiedPerDomain override must allow an exhaustive run"
echo "PASS: args.maxVerifiedPerDomain raises the cap for a deliberately exhaustive run"

exit 0
