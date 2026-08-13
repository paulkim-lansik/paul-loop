#!/usr/bin/env node
// gstack-scan.mjs — BAC-503 (ADR-0065): scan gstack's learnings.jsonl for domain lesson candidates
// and record them straight into the file lesson store (.loop/lessons), so the existing
// verified→challenge→retire pipeline (lessons.mjs) and graduation (graduate-lessons.mjs → pgvector)
// pick them up UNMODIFIED. Manual step of the `retrospect` skill (ADR-0065 decision 7) — not an
// automatic SessionStart hook.
//
// Scope (ADR-0065 decision 1): learnings.jsonl ONLY. decisions.jsonl (design decisions, not
// failure→fix pairs) and handoff-*.md (free prose) are out of scope.
//
// Dedup (decision 3): id = sha256(`${skill}:${key}`).slice(0,16), EXACT match. A lesson already on
// disk under that id is skipped entirely — no count increment, no rewrite. gstack items are
// "record once, then immutable": a re-scan of the same append-only line is not a real recurrence.
//
// Trust mapping (decision 2): only source:"user-stated" + trusted:true (gstack's own ground-truth
// marker — a human said this directly) becomes verified:true. Everything else (observed/cross-model/
// inferred) is verified:false and must clear the same recurring + skeptic-challenge bar as any
// engineering lesson before promotion. gstack's numeric `confidence` is never consulted (agent
// self-rating, not ground truth).
//
// Field mapping (decision 4): signature=[insight] (raw text, no FAIL-line normalization — that
// would mangle prose), title=key (already a slug), fix='' (no auto-extraction from prose).
//
// Exit: 0 on a completed scan (including 0 new lessons — a missing learnings.jsonl is not an error,
// gstack may simply have nothing yet for this repo); 2 on a usage error.

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

function usage(msg) {
  if (msg) process.stderr.write(`gstack-scan: ${msg}\n`)
  process.stderr.write('Usage: gstack-scan.mjs [--lessons <dir>] [--gstack-file <path>]\n')
  process.exit(2)
}

const argv = process.argv.slice(2)
const opt = { lessons: process.env.LESSONS_DIR || '.loop/lessons', gstackFile: '' }
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  const val = () => { if (i + 1 >= argv.length) usage(`${a} requires a value`); return argv[++i] }
  switch (a) {
    case '--lessons': opt.lessons = val(); break
    case '--gstack-file': opt.gstackFile = val(); break
    default: usage(`unknown arg ${a}`)
  }
}

// Scan target (decision 6): the single dir gstack keys off the repo's basename. CLAUDE.md §8 requires
// ALL work to happen in a linked worktree (never the main checkout) — `git rev-parse --show-toplevel`
// there returns the worktree's OWN path (e.g. `.../glucofit-worktrees/feature-x`), whose basename is
// NOT the repo name ADR-0065 targets ("glucofit-partners"). `--git-common-dir` instead resolves to the
// shared `.git` every worktree of this repo points at, regardless of which one invoked the scan — its
// parent is always the main repo root. No fallback to the legacy `pprs-dev-<repo>` remote-based
// namespace (one-off artifact, moved by hand if needed).
function defaultGstackFile() {
  // `--git-common-dir` can print a path relative to cwd (git's convention, like `--git-dir`) — resolve
  // it against cwd (execFileSync's default) before taking the parent, so the basename is never off cwd.
  let root
  try { root = dirname(resolve(execFileSync('git', ['rev-parse', '--git-common-dir'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim())) }
  catch { root = process.cwd() }
  return join(homedir(), '.gstack', 'projects', basename(root), 'learnings.jsonl')
}

const gstackFile = opt.gstackFile || defaultGstackFile()

if (!existsSync(gstackFile)) {
  process.stdout.write(`gstack-scan: no learnings file at ${gstackFile} — nothing to scan\n`)
  process.exit(0)
}

const raw = readFileSync(gstackFile, 'utf8')

function lessonPath(id) { return join(opt.lessons, `${id}.json`) }
function writeLessonFile(l) {
  mkdirSync(opt.lessons, { recursive: true })
  const p = lessonPath(l.id), tmp = `${p}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(l, null, 2) + '\n')
  renameSync(tmp, p)
}

let scanned = 0
let malformed = 0
let dupInFile = 0

// Pass 1: parse + validate every line, deduping WITHIN this file by id. gstack's `learnings.jsonl` is
// append-only, but it has been observed to re-emit a refined insight under the SAME skill:key (e.g. a
// pitfall re-worded an hour later) — the LAST occurrence wins, since it's gstack's own correction, not
// a distinct new item. This is a within-file concern, separate from decision 3's across-run dedup below.
const byId = new Map()
for (const line of raw.split('\n')) {
  const t = line.trim()
  if (!t) continue
  scanned++
  let entry
  try { entry = JSON.parse(t) } catch { malformed++; continue }
  if (!entry || typeof entry !== 'object'
    || typeof entry.skill !== 'string' || !entry.skill
    || typeof entry.key !== 'string' || !entry.key
    || typeof entry.insight !== 'string' || !entry.insight) {
    malformed++; continue
  }
  const id = createHash('sha256').update(`${entry.skill}:${entry.key}`).digest('hex').slice(0, 16)
  if (byId.has(id)) dupInFile++
  byId.set(id, entry)
}

// Pass 2: across-run dedup (decision 3) — a lesson already on disk from a PRIOR scan is left untouched.
let skipped = 0
let recorded = 0
let verifiedCount = 0
for (const [id, entry] of byId) {
  if (existsSync(lessonPath(id))) { skipped++; continue }
  const verified = entry.source === 'user-stated' && entry.trusted === true
  const ts = typeof entry.ts === 'string' && entry.ts ? entry.ts : new Date().toISOString()
  writeLessonFile({
    id, signature: [entry.insight], title: entry.key, fix: '', source: 'gstack', category: 'domain',
    verified, count: 1, iterations: [], first_seen: ts, last_seen: ts,
  })
  recorded++
  if (verified) verifiedCount++
}

process.stdout.write(`gstack-scan: ${gstackFile}\n`)
process.stdout.write(`  scanned=${scanned} recorded=${recorded} (verified=${verifiedCount} unverified=${recorded - verifiedCount}) skipped(existing)=${skipped} dup-in-file=${dupInFile} malformed=${malformed}\n`)
process.exit(0)
