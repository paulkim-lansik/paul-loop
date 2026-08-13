#!/usr/bin/env node
// gate.mjs — Phase 4 of loop-engine: the human-in-the-loop gate decision rule.
//
// Phases 0-3 ran autonomously by design. Phase 4 orchestrates plan->implement->verify->review->
// improve as ONE flow, and a long autonomous flow needs a concrete, defensible answer to the
// question the research left open: WHICH actions get a human approval checkpoint, and which run
// autonomously? Agents have no innate sense of blast radius, reversibility, or cost — so we encode
// one, deterministically, here. (classify-risk.sh / the ship-feature skill consults this before a
// stage it has classified.)
//
// The rule (3-tier since BAC-584 / ADR-0085 — user-approved 2026-08-05; the earlier binary rule
// emitted REQUIRE on 36/40 real merged PRs, so the verdict carried no routing information):
//   - reversibility = none      -> REQUIRE       (cannot be undone; a human approves before it runs)
//   - dimension missing/unknown -> REQUIRE       (FAIL CLOSED — misconfig must not silently run hot)
//   - blast=high OR cost=high   -> DENY_AND_LOG  (reversible but broad/expensive: the action is
//                                                 denied by default and the verdict evidence is
//                                                 loaded into the PR body, so the human reviews it
//                                                 at the PR/merge boundary — machine-enforced by
//                                                 the BAC-616 ask rules + BAC-563 hook)
//   - otherwise                 -> AUTO
// Invariant (ADR-0061 §5): merge/deploy/send reach this gate as reversibility=none via
// classify-risk (human-only stages / cmd-irreversible) and therefore always REQUIRE.
//
// The three dimensions are deliberately CATEGORICAL. The caller maps its concrete metric to a
// level; guidance (docs/orchestrate.md): high blast ~ >10 files OR prod / all-users scope;
// reversibility=none ~ deploy / delete / data migration / payment / outbound send / publish;
// high cost ~ a large API/compute spend or expensive human cleanup if it goes wrong.
//
// Usage:
//   gate.mjs --blast-radius <low|medium|high> --reversibility <full|partial|none> \
//            --cost <low|medium|high> [--action "<human-readable description>"]
//
// Output (machine-readable, greppable — same spirit as the Verdict Contract):
//   === GATE ===
//   GATE: AUTO|DENY_AND_LOG|REQUIRE
//   ACTION: <description, or "(unspecified)">
//   REASON: <why; lists every condition that tripped>
//   DIMENSIONS: blast_radius=<v> reversibility=<v> cost=<v>
//   === END GATE ===
//
// Exit: 0 = AUTO (safe to proceed autonomously), 10 = REQUIRE (needs human approval before running),
//       11 = DENY_AND_LOG (denied by default; the verdict evidence goes into the PR body for human
//       review at the merge boundary), 2 = usage error. (10/11, not 1, so a driver can tell a
//       verdict from a real error.)

function usage(msg) {
  if (msg) process.stderr.write(`gate: ${msg}\n`)
  process.stderr.write('Usage: gate.mjs --blast-radius <low|medium|high> --reversibility <full|partial|none> --cost <low|medium|high> [--action "..."]\n')
  process.exit(2)
}

const BLAST = ['low', 'medium', 'high']
const REVERS = ['full', 'partial', 'none']
const COST = ['low', 'medium', 'high']

const argv = process.argv.slice(2)
const opt = { blast: '', revers: '', cost: '', action: '' }
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  const val = () => { if (i + 1 >= argv.length) usage(`${a} requires a value`); return argv[++i] }
  switch (a) {
    case '--blast-radius': opt.blast = val(); break
    case '--reversibility': opt.revers = val(); break
    case '--cost': opt.cost = val(); break
    case '--action': opt.action = val(); break
    case '-h': case '--help': usage(); break
    default: usage(`unknown arg ${a}`)
  }
}

// Evaluate each dimension. A value outside its allowed set (including the empty string, i.e. the
// flag was never passed) FAILS CLOSED: it counts as a reason to require a human checkpoint.
// requireReasons force REQUIRE; middleReasons alone yield DENY_AND_LOG (ADR-0085 3-tier).
const requireReasons = []
const middleReasons = []
const classify = (name, value, allowed, highValue, bucket) => {
  if (!allowed.includes(value)) {
    requireReasons.push(`${name} is missing or unrecognised ("${value}") → fail closed to human approval`)
    return
  }
  if (value === highValue) bucket.push(`${name}=${value}`)
}
classify('reversibility', opt.revers, REVERS, 'none', requireReasons)
classify('blast_radius', opt.blast, BLAST, 'high', middleReasons)
classify('cost', opt.cost, COST, 'high', middleReasons)

const gate = requireReasons.length ? 'REQUIRE' : middleReasons.length ? 'DENY_AND_LOG' : 'AUTO'
const reason = requireReasons.length
  ? requireReasons.concat(middleReasons).join('; ')
  : middleReasons.length
    ? `${middleReasons.join('; ')} — reversible: deny by default, evidence into the PR (no human wait)`
    : 'all dimensions within autonomous thresholds (reversible, blast<high, cost<high)'

process.stdout.write('=== GATE ===\n')
process.stdout.write(`GATE: ${gate}\n`)
process.stdout.write(`ACTION: ${opt.action || '(unspecified)'}\n`)
process.stdout.write(`REASON: ${reason}\n`)
process.stdout.write(`DIMENSIONS: blast_radius=${opt.blast || '?'} reversibility=${opt.revers || '?'} cost=${opt.cost || '?'}\n`)
process.stdout.write('=== END GATE ===\n')

// exitCode (not exit): natural exit flushes pending stdout (same principle as classify-risk).
process.exitCode = gate === 'REQUIRE' ? 10 : gate === 'DENY_AND_LOG' ? 11 : 0
