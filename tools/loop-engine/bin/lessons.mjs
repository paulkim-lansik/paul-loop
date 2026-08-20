#!/usr/bin/env node
// lessons.mjs — Phase 3 of loop-engine: a verified-lessons memory (the learning layer).
//
// The loop (Phase 1) and gate (Phase 2) make one run converge. This makes runs get SMARTER over
// time: failures become reusable lessons (Reflexion), recurring lessons become skill candidates
// (Voyager), and a retro surfaces loop-efficiency. The discipline from Phases 0-2 holds:
//
//   ONLY the verifier decides what is a lesson. A lesson (and its fix/title/source) is trusted as
//   `verified` only when ground truth (the verifier passing after a fix) confirmed it — never the
//   fixer's self-report. Only verified lessons are recalled as authoritative, and only recurring
//   (count >= N) verified lessons are promoted to skill/guideline candidates. So a one-off or a
//   hallucinated "fix" cannot pollute the memory or the guidelines.
//
// Store: one JSON file per lesson under <lessons-dir>/, keyed by a normalized failure signature
// (git-diffable, merge-friendly). The store is HARDENED against hand-edited / merge-corrupted files:
// every lesson is coerced to sane types on load, and `verified` is authoritative only when it is
// the boolean `true`. NOTE: concurrent writers to ONE shared dir are serialized with a best-effort
// lock; if you run many loops in parallel against one committed dir, prefer per-run dirs + merge.
//
// Commands:
//   lessons record  --signature-file <verdict.txt> | --signature "<text>"
//                   [--fix "<what fixed it>"] [--title "<t>"] [--source loop-fix|loop-fix-fail|eval-gate|diagnose|review|manual]
//                   [--category engineering|domain] [--iterations N] [--verified] [--gate "<verify cmd>"] [--lessons <dir>]
//                   --gate attributes this recurrence to a verify gate (BAC-631). Both this key and the
//                   ledger's payload.cmd are normalized through lib/regression-signals normalizeGateKey
//                   (leading `sh -c ` wrapper stripped + ledger truncation rule), so "pnpm verify" and the
//                   loop-fix path's "sh -c pnpm verify" cross-reference as ONE gate in promote --runs.
//                   --verified requires --signature-file (issue #9, fail-closed): a hand-typed --signature
//                   string is not acceptable evidence for a verified record — usage error, exit 2.
//   lessons recall  (--signature-file|--signature) [--include-unverified]
//                   [--category engineering|domain] [--lessons <dir>]
//                   A miss (no lesson, or --category mismatch) is silent on stdout (exit 0 unchanged —
//                   loop-fix pipes this through `2>/dev/null`), but writes ONE stderr line naming the
//                   normalized signature key and, since a miss is often a natural-language query that
//                   was never a supported input for this exact-match store, a routing hint to semantic
//                   recall instead (ADR-0062; CONTEXT.md "Signature recall" / "Semantic recall").
//   lessons challenge --id <key> --verdict accept|reject [--reason "<why>"] [--by "<who>"] [--lessons <dir>]
//                   (Phase 4) record a separate skeptical evaluator's verdict on a promotion candidate.
//   lessons promote [--min-count N] [--include-unverified] [--codify] [--runs <runs-dir>] [--lessons <dir>]
//                   list candidates + challenge status; with --codify, emit ONLY accepted ones (fail closed).
//                   --runs (opt-in, BAC-631): fold the .loop/runs ledger and annotate the listing with
//                   deterministic gate PASS→FAIL regression signals — candidate INPUT only, the skeptical
//                   challenge gate is unchanged (the ledger is forgeable — lib/run-ledger.mjs trust boundary).
//                   LISTING ONLY: under --codify the flag is ignored (its machine-consumed handoff output
//                   stays clean of advisory signals).
//   lessons retire --id <key> [--ref "<where codified>"] [--by "<who>"] [--lessons <dir>]
//                   (Phase 4, TERMINAL) retire an accepted+codified lesson from the promotion pool so it
//                   stops re-surfacing (promote listing / --codify / a consumer-repo health-check
//                   script, if present). Fail closed: only a
//                   verified lesson with a recorded `challenge --verdict accept` may retire.
//   lessons invalidate --id <key> [--reason "<why>"] [--superseded-by <id2>] [--by "<who>"] [--lessons <dir>]
//                   Mark a lesson WRONG (the lesson itself was incorrect) — distinct from `retire`
//                   (the lesson was RIGHT but is now superseded/codified). An invalidated lesson is
//                   EXCLUDED, fail-closed, from every downstream surface: recall (never recalled, even
//                   if verified) and promote (candidates listing / --codify). --superseded-by (optional)
//                   fail-closed-checks the target id exists before writing.
//   lessons mark-clean --gate "<verify cmd>" [--lessons <dir>]
//                   Exit-code-derived counter: bump clean_pass_count on every lesson attributed to --gate
//                   (via gate_history) that is neither invalidated nor retired — how many times that gate
//                   has passed CLEANLY, i.e. without this lesson's fix being needed again. `record`'s
//                   fail-recurrence path resets it to 0 (a recurrence means the lesson is NOT stable yet).
//                   `promote`'s listing annotates lessons crossing CLEAN_RETIRE_THRESHOLD as retirement
//                   candidates — informational only, never auto-invalidates/retires.
//   lessons stats   [--category engineering|domain] [--lessons <dir>]
//
// category: `engineering` (process/tooling lesson, the default) or `domain` (product/domain lesson).
// Missing/legacy/malformed values coerce to `engineering` on read (BAC-498 — all pre-existing lessons
// predate this field, so they read as engineering with no migration needed).
//
// Exit: 0 ok, 2 usage error.

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, readdirSync, mkdirSync, rmdirSync, existsSync, renameSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { sanitizeText } from '../lib/sanitize.mjs'   // BAC-628 기록 시점 redaction
// BAC-631 회귀 신호 의존체 — best-effort 동적 import(웨이브2 교훈: 정적 import는 의존체 파손 시 파일
// 전체를 무음 무력화). loop-fix가 record를 `>/dev/null 2>&1`+`&&` 체인으로, recall을 `2>/dev/null`+
// exit 무시로 부르므로(loop-fix.sh:373-376·452) 정적 import 크래시는 루프 메모리의 기록·회상 두 경로를
// 소리 없이 죽인다. 이 의존체는 promote --runs(옵트인)와 --gate 정규화에만 필요 — 실패 시 그 둘만
// 강등(경고 1줄)하고 본연 명령(record/recall/promote/stats/challenge/retire/invalidate/mark-clean)은 산다.
let regressionSignals = null
try {
  regressionSignals = await import('../lib/regression-signals.mjs')
} catch (e) {
  process.stderr.write(`lessons: regression-signals 로드 실패(${e?.message ?? e}) — 회귀 신호·게이트 정규화 없이 진행\n`)
}

function usage(msg) {
  if (msg) process.stderr.write(`lessons: ${msg}\n`)
  process.stderr.write('Usage: lessons <record|recall|promote|stats|challenge|retire|invalidate|mark-clean> [options]  (see header)\n')
  process.exit(2)
}

const argv = process.argv.slice(2)
const cmd = argv.shift()
if (!cmd || !['record', 'recall', 'promote', 'stats', 'challenge', 'retire', 'invalidate', 'mark-clean'].includes(cmd)) usage(`unknown or missing command ${JSON.stringify(cmd || '')}`)

const opt = { lessons: process.env.LESSONS_DIR || '.loop/lessons', sigFile: '', sig: '', fix: '', title: '', source: '', category: '', iterations: null, verified: false, minCount: 3, includeUnverified: false, id: '', verdict: '', reason: '', by: '', ref: '', codify: false, gate: '', runs: '', supersededBy: '' }
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  const val = () => { if (i + 1 >= argv.length) usage(`${a} requires a value`); return argv[++i] }
  const posInt = (name, re) => { const r = val(); if (!re.test(r)) usage(`${name} must be a ${re === /^\d+$/ ? 'non-negative' : 'positive'} integer`); return Number(r) }
  switch (a) {
    case '--lessons': opt.lessons = val(); break
    case '--signature-file': opt.sigFile = val(); break
    case '--signature': opt.sig = val(); break
    case '--fix': opt.fix = val(); break
    case '--title': opt.title = val(); break
    case '--source': opt.source = val(); break
    case '--category': { const v = val(); if (v !== 'engineering' && v !== 'domain') usage('--category must be "engineering" or "domain"'); opt.category = v; break }
    case '--iterations': opt.iterations = posInt('--iterations', /^\d+$/); break
    case '--verified': opt.verified = true; break
    case '--min-count': opt.minCount = posInt('--min-count', /^[1-9]\d*$/); break
    case '--include-unverified': opt.includeUnverified = true; break
    case '--id': opt.id = val(); break
    case '--verdict': opt.verdict = val(); break
    case '--reason': opt.reason = val(); break
    case '--by': opt.by = val(); break
    case '--ref': opt.ref = val(); break
    case '--codify': opt.codify = true; break
    case '--gate': opt.gate = val(); break
    case '--runs': opt.runs = val(); break
    case '--superseded-by': opt.supersededBy = val(); break
    default: usage(`unknown arg ${a}`)
  }
}

// BAC-628: fix/title 자유텍스트는 사람/에이전트가 직접 넘기는 경로라 시크릿이 실릴 수 있다.
// LOG 경로는 verdict-run이 원천 살균하지만 --fix "export TOKEN=…" 같은 수기 입력은 여기서만 잡힌다.
opt.fix = sanitizeText(opt.fix)
opt.title = sanitizeText(opt.title)
// 같은 저장소(.loop/lessons/*.json — 커밋되는 파일)에 착지하는 나머지 자유텍스트 입력도 대칭 살균 —
// challenge --reason, retire --by/--ref, record --source. 비대칭이면 같은 문장이 --fix로는 살균되고
// --reason으로는 원문 착지한다(리뷰).
opt.source = sanitizeText(opt.source)
opt.reason = sanitizeText(opt.reason)
opt.by = sanitizeText(opt.by)
opt.ref = sanitizeText(opt.ref)
opt.gate = sanitizeText(opt.gate)
opt.supersededBy = sanitizeText(opt.supersededBy)
// 게이트 키 정규화(BAC-631) — 원장 payload.cmd와 같은 규칙(lib normalizeGateKey: `sh -c ` 래퍼 제거 +
// 절단 수렴)으로 맞춰야 promote --runs 교차 참조가 어긋나지 않는다. loop-fix 경로의 cmd는
// "sh -c pnpm verify"로 착지하므로 raw 문자열 비교는 영구 미매칭이었다(리뷰). lib 로드 실패 시엔
// raw 유지(위 경고가 이미 나감 — 신호 강등이지 record 실패가 아니다).
if (opt.gate && regressionSignals) opt.gate = regressionSignals.normalizeGateKey(opt.gate)

// ---- signature: the failure fingerprint (key). Normalised so the same KIND of failure recurs, but
//      WITHOUT erasing the semantics (assertion operands, exit/status codes) that distinguish bugs. ----
function failLinesFrom(text) {
  const fails = text.split('\n').filter(l => /^FAIL:/.test(l)).map(l => l.replace(/^FAIL:\s*/, ''))
  if (fails.length) return fails
  // No FAIL: lines (e.g. a bare --signature reason). Drop Verdict scaffolding, keep the rest.
  return text.split('\n').map(l => l.trim()).filter(l => l && !/^(=== |VERDICT:|EXIT:|SUMMARY:|LOG:|NOTE:)/.test(l))
}
function normalize(lines) {
  return lines.map(l => l
    .replace(/^\s*\d+:/, '')                          // grep line-number prefix "3:"
    .replace(/0x[0-9a-f]+/gi, '0x#')                  // hex addresses
    .replace(/\b\d{4}-\d{2}-\d{2}t[\d:.]+z?/gi, '<ts>')   // ISO timestamps
    .replace(/duration_ms=\d+/g, 'duration_ms=#')     // our own duration field
    .replace(/\b\d+(\.\d+)?\s?ms\b/g, '#ms')          // durations like "12ms"
    .replace(/:\d+(:\d+)?(?=\D|$)/g, ':#')            // :line or :line:col POSITIONS (noise)
    .replace(/\b(not ok|ok)\s+\d+/gi, '$1 #')         // TAP/jest test ORDINALS (renumber noise)
    .replace(/(^|[\s(])\/[^\s:)]+\//g, '$1')           // directory paths -> basenames
    .replace(/\s+/g, ' ')
    .trim().toLowerCase())
    .filter(Boolean)
    .sort()
}
function signatureOf() {
  // BAC-628: 서명 입력은 저장 전에 살균한다. record와 recall이 같은 이 함수를 지나므로 살균이
  // 양쪽에 대칭 적용되어 서명 키(sha256 16자)가 어긋나지 않는다(기록 시점 redaction의 키 불변).
  let lines
  if (opt.sigFile) { if (!existsSync(opt.sigFile)) usage(`signature file not found: ${opt.sigFile}`); lines = failLinesFrom(sanitizeText(readFileSync(opt.sigFile, 'utf8'))) }
  else if (opt.sig) { lines = failLinesFrom(sanitizeText(opt.sig)) }
  else return null
  const norm = normalize(lines)
  if (norm.length === 0) return null
  return { key: createHash('sha256').update(norm.join('\n')).digest('hex').slice(0, 16), norm }
}

// ---- store helpers (every read coerces to sane types: corrupt/hand-edited files cannot mislead) ----
function coerce(l) {
  if (!l || typeof l !== 'object') return null
  l.verified = l.verified === true
  l.count = Number.isInteger(l.count) && l.count >= 0 ? l.count : 0
  l.iterations = Array.isArray(l.iterations) ? l.iterations.filter(n => Number.isFinite(n)) : []
  if (typeof l.title !== 'string') l.title = ''
  if (typeof l.fix !== 'string') l.fix = ''
  // category: engineering (process/tooling, the default) or domain (product/domain). Missing/legacy/
  // malformed values coerce to 'engineering' — read-time default, so the ~95 pre-existing lessons need
  // no migration (BAC-498).
  l.category = (l.category === 'domain' || l.category === 'engineering') ? l.category : 'engineering'
  // A challenge is authoritative only when it is an object with verdict exactly 'accept'|'reject'.
  // Anything else (missing, hand-edited, merge-corrupted) coerces to null = UNCHALLENGED, which
  // fails closed: an uncertain challenge can never clear a candidate for codification.
  l.challenge = (l.challenge && typeof l.challenge === 'object' && (l.challenge.verdict === 'accept' || l.challenge.verdict === 'reject'))
    ? { verdict: l.challenge.verdict, reason: typeof l.challenge.reason === 'string' ? l.challenge.reason : '', by: typeof l.challenge.by === 'string' ? l.challenge.by : '', at: typeof l.challenge.at === 'string' ? l.challenge.at : '' }
    : null
  // A retirement (codified-into-guideline terminal marker) is authoritative only when it is an object
  // with a non-empty string `at`. Anything else coerces to null = NOT retired → the lesson stays in
  // the promotion pool. Fail closed: a corrupt/hand-edited retired field can never silently retire a
  // lesson that was never actually codified.
  l.retired = (l.retired && typeof l.retired === 'object' && typeof l.retired.at === 'string' && l.retired.at)
    ? { at: l.retired.at, ref: typeof l.retired.ref === 'string' ? l.retired.ref : '', by: typeof l.retired.by === 'string' ? l.retired.by : '' }
    : null
  // gate_history: 이 lesson의 재발이 어느 verify 게이트(원장 payload.cmd)에서 났는지의 귀속 이력
  // (BAC-631). 결손·손상은 {}로 강제 — read-time default라 기존 lesson 파일은 무마이그레이션
  // (BAC-498 category 선례). 값 형태({count:양의 정수, first_seen, last_seen})가 아니면 항목 낙하.
  l.gate_history = (l.gate_history && typeof l.gate_history === 'object' && !Array.isArray(l.gate_history))
    ? Object.fromEntries(Object.entries(l.gate_history)
        .filter(([k, v]) => k && v && typeof v === 'object' && Number.isInteger(v.count) && v.count > 0)
        .map(([k, v]) => [k, { count: v.count, first_seen: typeof v.first_seen === 'string' ? v.first_seen : '', last_seen: typeof v.last_seen === 'string' ? v.last_seen : '' }]))
    : {}
  // invalidation (BAC-571 port, issue #6) — distinct from `retired` (right but unused/superseded):
  // this marks the lesson itself WRONG. `invalid_at` is authoritative only when it is a non-empty
  // string (read-time default '' = NOT invalidated) — fail closed, same pattern as retired.at above.
  l.invalid_at = (typeof l.invalid_at === 'string' && l.invalid_at) ? l.invalid_at : ''
  l.invalid_reason = typeof l.invalid_reason === 'string' ? l.invalid_reason : ''
  l.superseded_by = typeof l.superseded_by === 'string' ? l.superseded_by : ''
  l.invalidated_by = typeof l.invalidated_by === 'string' ? l.invalidated_by : ''
  // clean_pass_count: exit-code-derived counter (`mark-clean`) of how many times this lesson's gate
  // passed WITHOUT this lesson's fix being needed again. Missing/corrupt coerces to 0 — read-time
  // default, no migration needed for pre-existing lessons.
  l.clean_pass_count = Number.isInteger(l.clean_pass_count) && l.clean_pass_count >= 0 ? l.clean_pass_count : 0
  return l
}
function ensureDir() { mkdirSync(opt.lessons, { recursive: true }) }
function lessonPath(key) { return join(opt.lessons, `${key}.json`) }
function readLesson(key) {
  const p = lessonPath(key)
  if (!existsSync(p)) return null
  try { return coerce(JSON.parse(readFileSync(p, 'utf8'))) } catch { return null }
}
function writeLesson(l) {
  ensureDir()
  const p = lessonPath(l.id), tmp = `${p}.${process.pid}.tmp`     // unique tmp: concurrent writers don't clobber
  writeFileSync(tmp, JSON.stringify(l, null, 2) + '\n'); renameSync(tmp, p)
}
function allLessons() {
  if (!existsSync(opt.lessons)) return []
  return readdirSync(opt.lessons).filter(f => f.endsWith('.json')).map(f => { try { return coerce(JSON.parse(readFileSync(join(opt.lessons, f), 'utf8'))) } catch { return null } }).filter(Boolean)
}

// best-effort cross-process lock so the read-modify-write of `record` doesn't lose count updates
function sleepMs(ms) { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) } catch { /* noop */ } }
function withLock(fn) {
  ensureDir()
  const lock = join(opt.lessons, '.lock')
  for (let i = 0; i < 150; i++) {
    try { mkdirSync(lock) } catch (e) { if (e.code === 'EEXIST') { sleepMs(20); continue } throw e }
    try { return fn() } finally { try { rmdirSync(lock) } catch { /* noop */ } }
  }
  return fn()   // last resort: proceed unlocked rather than fail the caller's loop
}
const nowIso = () => new Date().toISOString()
const avg = a => a.length ? (a.reduce((x, y) => x + y, 0) / a.length) : null

// ---- commands ----
if (cmd === 'record') {
  const s = signatureOf()
  if (!s) usage('record needs --signature-file or --signature with at least one FAIL line')
  // Evidence integrity (issue #9): a --verified record is a claim that ground truth (the verifier)
  // confirmed a fix. A hand-typed --signature string carries no evidence trail — anyone can type
  // any text. Fail closed: --verified requires --signature-file (a real file path, i.e. an actual
  // verdict/log artifact on disk). Unverified records (no --verified) are unaffected — this is a
  // constraint on the VERIFIED claim only, not on record() in general.
  if (opt.verified && !opt.sigFile) usage('refusing --verified record without --signature-file — hand-typed --signature text is not acceptable evidence for a verified lesson (fail-closed, evidence must be a file). Use --signature-file <path> instead, or drop --verified.')
  const msg = withLock(() => {
    const existing = readLesson(s.key)
    if (existing) {
      existing.count += 1
      existing.last_seen = nowIso()
      // fail-recurrence: this signature came back, so any "clean since" streak (mark-clean) is no
      // longer true — a recurrence is evidence the lesson is NOT yet stable. Reset to 0.
      existing.clean_pass_count = 0
      existing.verified = existing.verified || opt.verified
      if (opt.iterations != null) existing.iterations.push(opt.iterations)
      // Trust fix/title/source updates only from a VERIFIED record (or while the lesson is not yet
      // verified). This is the discipline: a self-reported fix can never overwrite verified knowledge.
      const trust = opt.verified || !existing.verified
      const nextFix = (opt.fix && opt.verified) ? opt.fix : existing.fix
      const nextTitle = (opt.title && trust) ? opt.title : existing.title
      // The skeptic accepts a SPECIFIC title+fix, and retirement retires that SPECIFIC codified content.
      // If the content changes, BOTH the prior verdict and the retirement are stale — clear them so a
      // recurrence with new content re-enters the pool for fresh review, and `promote --codify` can never
      // emit un-reviewed content under the old accept. Fail closed: any content change forces a fresh
      // `lessons challenge` (and, if re-codified, a fresh `lessons retire`).
      const contentChanged = nextFix !== existing.fix || nextTitle !== existing.title
      if (existing.challenge && contentChanged) existing.challenge = null
      if (existing.retired && contentChanged) existing.retired = null
      existing.fix = nextFix
      existing.title = nextTitle
      if (opt.source && trust) existing.source = opt.source
      // category is NOT trust-gated (any --category re-record updates it, verified or not). This is
      // safe today because nothing downstream (promote/challenge/retire/--codify) reads category — it
      // is pure display/filter metadata, so there is no verified claim to launder past a gate. If a
      // future gate ever branches on category (e.g. a domain-only codification path), move this line
      // behind `trust` at that point, same as `source` above.
      if (opt.category) existing.category = opt.category
      // gate_history is NOT trust-gated (same reasoning as category above): it is pure signal metadata —
      // no downstream gate (promote/challenge/retire/--codify) branches on it, promote --runs only uses it
      // to ANNOTATE candidates. PASS history stays in the .loop/runs ledger (SSOT) — never copied here.
      // A gate_history update is not a content change either, so challenge/retired stay untouched.
      if (opt.gate) {
        // own-property만 읽고(위조 게이트명 "constructor" 등이 프로토타입 체인을 타는 것 차단),
        // 쓰기는 defineProperty — 게이트명 "__proto__"의 일반 대입은 프로토타입 세터를 타서
        // 기록이 무음 유실된다(리뷰 실측). 신규 리터럴의 computed key는 own property라 무해.
        const prev = Object.hasOwn(existing.gate_history, opt.gate) ? existing.gate_history[opt.gate] : undefined
        Object.defineProperty(existing.gate_history, opt.gate, {
          value: { count: (prev?.count || 0) + 1, first_seen: prev?.first_seen || nowIso(), last_seen: nowIso() },
          enumerable: true, writable: true, configurable: true,
        })
      }
      writeLesson(existing)
      return `updated ${s.key} (count=${existing.count}, verified=${existing.verified})`
    }
    const l = {
      id: s.key, signature: s.norm, title: opt.title || s.norm[0].slice(0, 100),
      fix: (opt.fix && opt.verified) ? opt.fix : '', source: opt.source || 'manual',
      category: opt.category || 'engineering',
      verified: opt.verified, count: 1, iterations: opt.iterations != null ? [opt.iterations] : [],
      gate_history: opt.gate ? { [opt.gate]: { count: 1, first_seen: nowIso(), last_seen: nowIso() } } : {},
      first_seen: nowIso(), last_seen: nowIso(),
    }
    writeLesson(l)
    return `recorded ${s.key} (verified=${opt.verified})`
  })
  process.stdout.write(`lessons: ${msg}\n`)
  process.exit(0)
}

if (cmd === 'challenge') {
  // Phase 4: the separate skeptical-evaluator's verdict on a promotion candidate, RECORDED so it
  // is auditable and git-diffable. The evaluator (an agent or a human) is the generator of the
  // verdict; this just persists it. Codification (promote --codify) then trusts ONLY 'accept'.
  if (!opt.id) usage('challenge needs --id <lesson-key> (run "lessons promote" to see ids)')
  if (opt.verdict !== 'accept' && opt.verdict !== 'reject') usage('challenge needs --verdict accept|reject')
  const msg = withLock(() => {
    const l = readLesson(opt.id)
    if (!l) return null
    l.challenge = { verdict: opt.verdict, reason: opt.reason || '', by: opt.by || 'skeptical-evaluator', at: nowIso() }
    writeLesson(l)
    return `challenged ${opt.id}: ${opt.verdict}${opt.reason ? ` — ${opt.reason}` : ''}`
  })
  if (msg === null) usage(`no lesson with id ${opt.id} (run "lessons promote --lessons ${opt.lessons}" to see candidate ids)`)
  process.stdout.write(`lessons: ${msg}\n`)
  process.exit(0)
}

if (cmd === 'retire') {
  // Phase 4, TERMINAL: mark a lesson as codified into a skill / CLAUDE.md guideline. This RETIRES it
  // from the promotion pool — `promote` (listing + --codify) and `stats` open-candidate count exclude
  // retired lessons, so a once-codified lesson stops re-surfacing forever (no false-nag from a
  // consumer-repo health-check script, if present, no double-codification). This is the third gate:
  // the verified+recurring floor gates ENTRY, the
  // recorded accept gates EXIT to codification, and `retire` gates removal from the candidate pool.
  // Fail closed: only a lesson the skeptic has ACCEPTED (verified + challenge.verdict==='accept') may be
  // retired — you cannot retire something that was never cleared to codify.
  if (!opt.id) usage('retire needs --id <lesson-key> (run "lessons promote" to see ids)')
  const res = withLock(() => {
    const l = readLesson(opt.id)
    if (!l) return { err: 'notfound' }
    if (!(l.verified === true && l.challenge && l.challenge.verdict === 'accept')) return { err: 'notcleared' }
    l.retired = { at: nowIso(), ref: opt.ref || '', by: opt.by || 'human' }
    writeLesson(l)
    return { ok: `retired ${opt.id} (out of the promotion pool)${opt.ref ? ` → ${opt.ref}` : ''}` }
  })
  if (res.err === 'notfound') usage(`no lesson with id ${opt.id} (run "lessons promote --lessons ${opt.lessons}" to see candidate ids)`)
  if (res.err === 'notcleared') {
    process.stderr.write(`lessons: refusing to retire ${opt.id} — only a verified lesson with a recorded "challenge --verdict accept" may be retired (codified). Run "lessons challenge --id ${opt.id} --verdict accept" first.\n`)
    process.exit(2)
  }
  process.stdout.write(`lessons: ${res.ok}\n`)
  process.exit(0)
}

if (cmd === 'invalidate') {
  // Mark a lesson WRONG — distinct from `retire` (right but superseded/codified). This is the OTHER
  // terminal-ish state: unlike retire, invalidate carries no floor (a bad lesson can be caught before
  // it is ever verified or recurring). Fail closed downstream: an invalidated lesson must never surface
  // via recall (checked ahead of the verified check), nor via promote (candidates listing / --codify).
  if (!opt.id) usage('invalidate needs --id <lesson-key> (run "lessons promote" to see ids)')
  const res = withLock(() => {
    const l = readLesson(opt.id)
    if (!l) return { err: 'notfound' }
    // Fail closed: a --superseded-by pointing at a non-existent id would silently record a dangling
    // reference (promote/recall trust it as a hint, never dereference it, but a typo here should not
    // land silently — same "don't write what can't be true" discipline as retire's notcleared gate).
    if (opt.supersededBy && !readLesson(opt.supersededBy)) return { err: 'supersedednotfound' }
    l.invalid_at = nowIso()
    l.invalid_reason = opt.reason || ''
    l.superseded_by = opt.supersededBy || ''
    l.invalidated_by = opt.by || 'human'
    writeLesson(l)
    return { ok: `invalidated ${opt.id}${opt.reason ? ` — ${opt.reason}` : ''}${opt.supersededBy ? ` (superseded by ${opt.supersededBy})` : ''}` }
  })
  if (res.err === 'notfound') usage(`no lesson with id ${opt.id} (run "lessons promote --lessons ${opt.lessons}" to see candidate ids)`)
  if (res.err === 'supersedednotfound') usage(`superseded-by target ${opt.supersededBy} does not exist`)
  process.stdout.write(`lessons: ${res.ok}\n`)
  process.exit(0)
}

if (cmd === 'mark-clean') {
  // Exit-code-derived counter: the caller (loop-fix / a gate wrapper) tells us --gate passed CLEANLY
  // this run, so every lesson attributed to that gate (gate_history) that is still an ACTIVE candidate
  // (not already invalidated, not already retired) gets its clean_pass_count bumped. `record`'s
  // fail-recurrence path resets this to 0, so this is genuinely "consecutive clean passes since the
  // last recurrence" — not a lifetime total.
  if (!opt.gate) usage('mark-clean needs --gate "<verify cmd>"')
  const n = withLock(() => {
    let marked = 0
    for (const l of allLessons()) {
      if (Object.hasOwn(l.gate_history, opt.gate) && !l.invalid_at && !l.retired) {
        l.clean_pass_count += 1
        writeLesson(l)
        marked++
      }
    }
    return marked
  })
  process.stdout.write(`lessons: marked ${n} lesson(s) clean for gate ${opt.gate}\n`)
  process.exit(0)
}

if (cmd === 'recall') {
  const s = signatureOf()
  if (!s) usage('recall needs --signature-file or --signature with at least one FAIL line')
  const l = readLesson(s.key)
  // Invalidated lessons are NEVER recalled — checked ahead of the verified check, because a WRONG
  // lesson that happens to also be `verified` must still not surface (fail closed; the whole point of
  // invalidate is "this was verified once, but it's wrong now"). Same silent-stdout/exit-0 contract as
  // a plain miss, but the stderr line says INVALIDATED (not "no lesson") so it's diagnosable.
  if (l && l.invalid_at) {
    process.stderr.write(`lessons: lesson ${s.key} is INVALIDATED (${l.invalid_reason})${l.superseded_by ? `, superseded by ${l.superseded_by}` : ''} — not recalled\n`)
    process.exit(0)
  }
  // Signature recall is an EXACT match on the normalized failure key — no similarity, no ranking
  // (ADR-0062). A miss stays silent on stdout/exit-code (loop-fix pipes this through `2>/dev/null`),
  // but writes ONE stderr line: the key it looked up, and a routing hint since a miss is often a
  // hand-typed natural-language query — not a supported input for this store.
  if (!l || (!l.verified && !opt.includeUnverified)) {
    process.stderr.write(`lessons: no verified lesson for signature ${s.key} (exact match only — if this was a natural-language query, use semantic recall instead: pnpm --filter @glucofit-partners/loop-memory recall --query "<text>" --json)\n`)
    process.exit(0)   // nothing authoritative to say
  }
  if (opt.category && l.category !== opt.category) {
    process.stderr.write(`lessons: lesson ${s.key} exists but category is "${l.category}", not "${opt.category}"\n`)
    process.exit(0)   // filtered out by --category
  }
  const a = avg(l.iterations)
  const out = [`Past lesson for this failure (${l.verified ? 'verified' : 'UNVERIFIED'}, seen ${l.count}×):`, `- ${l.title}`]
  if (l.fix) out.push(`  what worked before: ${l.fix}`)
  if (a != null) out.push(`  typically converges in ~${a.toFixed(1)} iteration(s)`)
  process.stdout.write(out.join('\n') + '\n')
  process.exit(0)
}

// Informational-only threshold for promote's "retirement candidate" annotation (issue #6): a lesson
// whose gate has passed this many times CLEANLY (mark-clean) since its last recurrence is a signal the
// lesson may no longer be needed — never an auto-retire/invalidate, same "signal only" spirit as the
// --runs REGRESSION annotation below.
const CLEAN_RETIRE_THRESHOLD = 5

if (cmd === 'promote') {
  // The deterministic FLOOR for the candidate pool: verified (ground-truth) + recurring (count>=N).
  const pool = allLessons()
    .filter(l => l.count >= opt.minCount && (l.verified || opt.includeUnverified))
    .sort((a, b) => b.count - a.count)
  // Retired lessons have already been codified into a skill/CLAUDE.md (right but superseded) — they
  // must not re-surface as candidates (listing) nor be re-emitted for codification (--codify).
  // Invalidated lessons (WRONG, issue #6) get the same fail-closed exclusion. Partition both out.
  const retiredCount = pool.filter(l => l.retired).length
  const invalidatedCount = pool.filter(l => l.invalid_at).length
  const candidates = pool.filter(l => !l.retired && !l.invalid_at)

  if (opt.codify) {
    // The codification OUTPUT (Phase 4): emit ONLY candidates a separate skeptical evaluator has
    // explicitly ACCEPTED (via `lessons challenge --verdict accept`). Fail closed — an unchallenged
    // or rejected candidate is never handed to write-a-skill / CLAUDE.md. The verified+recurring
    // floor gates ENTRY to the pool; the recorded accept gates EXIT to a codified guideline.
    // Re-assert the VERIFIED floor on the codify EXIT path regardless of --include-unverified:
    // that flag may relax recall/listing, but ONLY ground-truth-verified lessons may ever be codified
    // into a skill/guideline (the verifier is the ceiling). A self-reported, never-verified "fix" must
    // not reach write-a-skill / CLAUDE.md even if a skeptic accepted it. Fail closed.
    // !l.invalid_at is re-asserted here too even though `candidates` already excludes it — this is the
    // single most safety-critical filter in the file (an invalidated lesson reaching write-a-skill /
    // CLAUDE.md would codify a KNOWN-WRONG lesson), so it gets defense-in-depth, not just one filter.
    const accepted = candidates.filter(l => l.verified === true && !l.invalid_at && l.challenge && l.challenge.verdict === 'accept')
    if (accepted.length === 0) {
      process.stdout.write('lessons: 0 candidate(s) cleared for codification — none has a recorded "lessons challenge --verdict accept"\n')
      process.exit(0)
    }
    process.stdout.write(`lessons: ${accepted.length} candidate(s) cleared to codify (write-a-skill / CLAUDE.md):\n`)
    for (const l of accepted) process.stdout.write(`  ${l.id}  [${l.count}×] ${l.title}${l.fix ? `  → ${l.fix}` : ''}  (accepted by ${l.challenge.by || 'skeptical-evaluator'}${l.challenge.reason ? `: ${l.challenge.reason}` : ''})\n`)
    process.stdout.write('After folding each into a skill/CLAUDE.md, RETIRE it so it stops re-emitting:\n')
    for (const l of accepted) process.stdout.write(`  lessons retire --id ${l.id} --ref "<skill or CLAUDE.md#section>"\n`)
    process.exit(0)
  }

  // BAC-631 (opt-in via --runs): fold the .loop/runs ledger deterministically and surface gate
  // PASS→FAIL regressions alongside the listing. The ledger is FORGEABLE (lib/run-ledger.mjs trust
  // boundary — an unprotected, gitignored file), so a regression line is a candidate INPUT to the
  // promotion pipeline, never an auto-promotion: the skeptical challenge gate below is unchanged.
  // Read failure is fail-open (one stderr warning, listing intact) — the signal must never break promote.
  let reg = null
  if (opt.runs) {
    if (!regressionSignals) {
      process.stderr.write(`lessons: --runs ${opt.runs} — regression-signals 미로드(상단 경고 참조), 회귀 신호 없이 진행\n`)
    } else {
      try {
        const src = regressionSignals.readRunEvents(opt.runs)
        if (src.missing) process.stderr.write(`lessons: --runs ${opt.runs} 원장 없음/읽기 실패 — 회귀 신호 없이 진행\n`)
        else {
          reg = regressionSignals.detectRegressions(src.events)
          // 부분 결손은 침묵 탈락 금지(run-metrics 규약) — 손상된 원장이 "회귀 0건"과 구별되지 않으면
          // 이 기능이 막으려던 무음 무력화가 기능 자신에게 일어난다(리뷰 실측: version 전량 불일치
          // 원장이 건강 출력과 byte-identical). 카운터가 하나라도 0이 아니면 stderr 1줄로 병기.
          const dropped = src.skipped_lines + src.skipped_files + reg.skipped_events
          if (dropped > 0) process.stderr.write(`lessons: --runs 원장 부분 결손 — skipped_lines=${src.skipped_lines} skipped_files=${src.skipped_files} skipped_events=${reg.skipped_events} (회귀 신호가 불완전할 수 있음)\n`)
        }
      } catch (e) {
        // readRunEvents/detectRegressions는 설계상 던지지 않는다 — 여기 도달은 그 자체의 버그.
        // 원인을 삼키면 "원장 읽기 실패"로 오귀속된다(리뷰) — e.message를 병기(fail-open은 유지).
        process.stderr.write(`lessons: --runs ${opt.runs} 회귀 fold 실패(${e?.message ?? e}) — 회귀 신호 없이 진행\n`)
      }
    }
  }
  // Independent section (below the listing, above Next:): a regression surfaces even when no lesson is
  // attributed to that gate — the issue's point is feeding the pipeline INPUT, not only annotating.
  const writeRegSection = () => {
    if (!reg || reg.regressions.length === 0) return
    process.stdout.write(`gate regressions (deterministic, from ${opt.runs}):\n`)
    for (const r of reg.regressions) process.stdout.write(`  REGRESSION: ${r.gate} PASS→FAIL last_pass=${r.last_pass_ts} first_fail=${r.first_fail_ts} fails=${r.fail_count}\n`)
  }

  // The LISTING: OPEN candidates (not yet retired) that pass the floor, each with its challenge
  // status, so the skeptical evaluator can accept/reject by id BEFORE anything is codified. Already-
  // retired lessons are hidden (reported as a count only).
  const excludedNote = (retiredCount || invalidatedCount) ? ` (${retiredCount} already retired, ${invalidatedCount} invalidated — excluded)` : ''
  if (candidates.length === 0) { process.stdout.write(`lessons: no open recurring (>=${opt.minCount}×) verified candidates to promote${excludedNote}\n`); writeRegSection(); process.exit(0) }
  process.stdout.write(`lessons: ${candidates.length} open candidate(s) passing the floor (verified + recurring, not yet retired)${excludedNote}. Challenge each before codifying:\n`)
  for (const l of candidates) {
    const status = !l.challenge ? 'UNCHALLENGED — needs skeptical review'
      : l.challenge.verdict === 'accept' ? `ACCEPTED by ${l.challenge.by || 'skeptical-evaluator'}${l.challenge.reason ? `: ${l.challenge.reason}` : ''}`
      : `REJECTED by ${l.challenge.by || 'skeptical-evaluator'}${l.challenge.reason ? `: ${l.challenge.reason}` : ''}`
    process.stdout.write(`  ${l.id}  [${l.count}×] ${l.title}${l.fix ? `  → ${l.fix}` : ''}\n      [${status}]\n`)
    // Per-candidate regression annotation — a SEPARATE line so it is visually distinct from the [N×]
    // recurrence count (AC②). Matches on the lesson's gate_history keys ∩ regressed gates.
    // own-property 검사 필수 — truthy 검사는 위조 원장의 게이트명 "constructor"/"toString"이
    // Object.prototype을 타고 gate_history 없는 후보 전원에 허위 귀속 줄을 붙인다(리뷰 실측).
    if (reg) {
      for (const r of reg.regressions) {
        if (Object.hasOwn(l.gate_history, r.gate)) process.stdout.write(`      [REGRESSION: ${r.gate} PASS→FAIL last_pass=${r.last_pass_ts} first_fail=${r.first_fail_ts} — .loop/runs 결정론 집계]\n`)
      }
    }
    // Retirement-candidate annotation (issue #6) — purely informational, same spirit as the REGRESSION
    // annotation above: a signal for a human/skeptic to act on via `lessons invalidate`, never an
    // automatic delete/invalidate.
    if (l.clean_pass_count >= CLEAN_RETIRE_THRESHOLD) {
      process.stdout.write(`      [RETIREMENT CANDIDATE: clean_pass_count=${l.clean_pass_count} — gate가 이 교훈 없이도 ${l.clean_pass_count}회 깨끗하게 통과함. superseded/무관해졌다면 "lessons invalidate"로 표시할 것]\n`)
    }
  }
  writeRegSection()
  process.stdout.write(`Next: lessons challenge --id <id> --verdict accept|reject --reason "..." --lessons ${opt.lessons}\n`)
  process.stdout.write('Then: lessons promote --codify  (emits only accepted candidates)\n')
  process.stdout.write('Last: lessons retire --id <id> --ref "<where>"  (after codifying — retires it from the pool)\n')
  process.exit(0)
}

if (cmd === 'stats') {
  const everything = allLessons()
  // by-category breakdown, always over the FULL set (not narrowed by --category) so it stays the one
  // place to see the engineering/domain split regardless of what the rest of this run is filtered to.
  const byCategory = { engineering: 0, domain: 0 }
  for (const l of everything) byCategory[l.category] = (byCategory[l.category] || 0) + 1
  // --category narrows every OTHER metric below (total/verified/recurring/... ) to that category.
  const all = opt.category ? everything.filter(l => l.category === opt.category) : everything
  const verified = all.filter(l => l.verified)
  const recurring = all.filter(l => l.count >= 2)
  const retired = all.filter(l => l.retired)
  const invalidated = all.filter(l => l.invalid_at)
  // open_candidates = the ACTIONABLE promotion backlog: verified + recurring, and in NONE of the
  // terminal/excluded states — not already retired (codified, out of the pool), not invalidated (WRONG,
  // issue #6 — same exclusion as promote's `candidates`, so this count never claims more "승격 후보"
  // than `promote` would actually list), and not rejected (skeptic decided no). This is what a
  // consumer-repo health-check script (if present) would report as "승격 후보"; it falls to 0 once
  // every recurring lesson is either codified+retired,
  // invalidated, or rejected, instead of the raw recurring count that never falls (a permanent
  // false-nag pre-retire). A rejected lesson re-opens automatically if it recurs with changed content
  // (record clears the stale verdict), so excluding it here loses nothing.
  const openCandidates = all.filter(l => l.verified && l.count >= 2 && !l.retired && !l.invalid_at && !(l.challenge && l.challenge.verdict === 'reject'))
  const iters = verified.flatMap(l => l.iterations)
  const a = avg(iters)
  process.stdout.write('=== lessons stats ===\n')
  process.stdout.write(`total=${all.length} verified=${verified.length} recurring(>=2x)=${recurring.length} retired=${retired.length} invalidated=${invalidated.length} open_candidates=${openCandidates.length} total_recurrences=${all.reduce((x, l) => x + l.count, 0)}\n`)
  process.stdout.write(`by_category: engineering=${byCategory.engineering} domain=${byCategory.domain}\n`)
  process.stdout.write(`avg_iterations_to_green=${a == null ? 'n/a' : a.toFixed(2)} (over ${iters.length} verified convergence(s))\n`)
  const top = all.slice().sort((a, b) => b.count - a.count).slice(0, 5)
  if (top.length) { process.stdout.write('top recurring blockers:\n'); for (const l of top) process.stdout.write(`  [${l.count}×]${l.verified ? '' : ' (unverified)'} ${l.title}\n`) }
  process.stdout.write('=== end stats ===\n')
  process.exit(0)
}
