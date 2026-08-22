#!/usr/bin/env node
// bin/check-docs-hygiene.mjs — BAC-754 (ported from glucofit-partners' tools/check-docs-hygiene.mjs,
// originally BAC-558/BAC-551/BAC-574 — see that repo's history for the incident this codifies).
//
// docs 위생을 값싼 정적 검사로 게이트한다. `docs/adr/`의 번호 유일성/README 인덱스 완전성처럼
// 사람 기억에만 의존하면 조용히 드리프트하는 불변식을 여기서 기계로 잠근다. 4개 체크, 앞 3개는
// RED(게이트), SKILL.md 단어수 상한은 WARN만(예방 가드).
//
//   1. ADR 번호 유일성 — docs/adr/*.md 파일명 번호에 중복·결번 없음
//   2. README 인덱스 완전성 — 파일 번호 집합 == docs/adr/README.md 링크 번호 집합 (양방향)
//   3. dangling reference — 링크(`[..](path)`)는 CLAUDE.md·docs/adr/** 전체에서, 레포 경로로 보이는
//      백틱 스팬(`apps/`·`docs/`·`.claude/` 등 알려진 최상위 디렉터리로 시작)은 **CLAUDE.md만**에서
//      검사한다. ADR은 의사결정 당시 시점의 스냅샷이라 그 뒤 파일이 삭제·이동돼도 정상(역사 기록) —
//      실측 확인: docs/adr/**에 같은 백틱 검사를 적용했더니 실패 80건 전부가 정당한 역사적 언급(예:
//      ADR-0078이 기록한 tools/loop-engine의 plugin 추출 이후 경로, ADR-0062의 회전 만료된
//      .loop/lessons/<id>.json)이었다 — CLAUDE.md는 "현재" 컨벤션을 서술하는 always-on 헌법이라
//      다르다(BAC-551의 실제 적발도 CLAUDE.md였다). CLAUDE.md 안에서도 "이제 없다"는 취지의 서술은
//      NEGATION_CUES로 같은 줄에서 억제한다(예: §8의 `.claude/skills/ship-feature`는 "더 이상 없다"는
//      의도적 부재 서술).
//   4. SKILL.md 단어수 상한 — 공식 기준 2,000(target)/5,000(max) 단어. WARN만, exit code에 반영 안 함
//
// Exit 0 unless check 1-3 fail. --json으로 기계가독 결과, --root로 픽스처 루트 지정(테스트용).

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

function resolveRoot(argv) {
  const i = argv.indexOf('--root');
  if (i !== -1 && argv[i + 1]) return resolve(argv[i + 1]);
  return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
}

const argv = process.argv.slice(2);
const ROOT = resolveRoot(argv);
const asJson = argv.includes('--json');

const failures = []; // { check, detail }
const warnings = []; // { check, detail }

// ── 1+2: ADR 번호 유일성 + README 인덱스 완전성 ──────────────────────────────────────────────
function checkAdrCorpus() {
  const adrDir = join(ROOT, 'docs/adr');
  if (!existsSync(adrDir)) return;

  const files = readdirSync(adrDir).filter(
    (f) => /^\d{4}-.+\.md$/.test(f) && f !== '0000-template.md',
  );
  const numSet = new Set();
  const dupes = new Set();
  for (const f of files) {
    const n = f.slice(0, 4);
    if (numSet.has(n)) dupes.add(n);
    numSet.add(n);
  }
  if (dupes.size > 0) {
    failures.push({
      check: 'adr-number-uniqueness',
      detail: `중복 번호: ${[...dupes].sort().join(', ')}`,
    });
  }

  const sorted = [...numSet].map(Number).sort((a, b) => a - b);
  if (sorted.length > 0) {
    const [min, max] = [sorted[0], sorted[sorted.length - 1]];
    const missing = [];
    for (let n = min; n <= max; n++) {
      const padded = String(n).padStart(4, '0');
      if (!numSet.has(padded)) missing.push(padded);
    }
    if (missing.length > 0) {
      failures.push({ check: 'adr-number-gaps', detail: `결번: ${missing.join(', ')}` });
    }
  }

  const readmePath = join(adrDir, 'README.md');
  if (existsSync(readmePath)) {
    const readme = readFileSync(readmePath, 'utf8');
    const readmeNums = new Set([...readme.matchAll(/\[(\d{4})\]/g)].map((m) => m[1]));
    const missingFromReadme = [...numSet].filter((n) => !readmeNums.has(n)).sort();
    const missingFromFiles = [...readmeNums].filter((n) => !numSet.has(n)).sort();
    if (missingFromReadme.length > 0) {
      failures.push({
        check: 'adr-readme-index-completeness',
        detail: `docs/adr/README.md 인덱스 누락(파일은 있는데 표에 없음): ${missingFromReadme.join(', ')}`,
      });
    }
    if (missingFromFiles.length > 0) {
      failures.push({
        check: 'adr-readme-index-completeness',
        detail: `docs/adr/README.md가 존재하지 않는 파일을 가리킴: ${missingFromFiles.join(', ')}`,
      });
    }
  }
}

// ── 3: dangling reference (CLAUDE.md + docs/adr/**/*.md) ───────────────────────────────────────
const REPO_PATH_PREFIXES = [
  'apps/',
  'docs/',
  'infra/',
  'packages/',
  'tools/',
  '.claude/',
  '.github/',
  '.husky/',
  '.loop/',
];

function stripAnchorAndTitle(target) {
  let t = target.trim();
  const spaceIdx = t.search(/\s/);
  if (spaceIdx !== -1) t = t.slice(0, spaceIdx);
  const hashIdx = t.indexOf('#');
  if (hashIdx !== -1) t = t.slice(0, hashIdx);
  return t;
}

function isCheckableRepoPath(p) {
  if (!p) return false;
  if (p.includes('*')) return false; // glob, not a literal path
  if (/^[a-z]+:/i.test(p)) return false; // scheme (http:, https:, mailto:, ...)
  return true;
}

// 백틱 스팬 전용 필터 — 명령어 체인·placeholder·brace-expansion을 걸러 CLAUDE.md 백틱 검사의
// 오탐을 없앤다(실측: apps/api/src/<feature>/<name>.ts, .claude/skills/{a,b}, `cmd1 && cmd2` 등).
function isCheckableBacktickPath(p) {
  if (!isCheckableRepoPath(p)) return false;
  if (p.includes(' ') || p.includes('<') || p.includes('{')) return false;
  return true;
}

const NEGATION_CUES = ['더 이상 없다', '더는 없다', '이제 없다', '삭제됨', '폐기됨', '제거됨'];

function lineContaining(content, index) {
  const start = content.lastIndexOf('\n', index) + 1;
  const end = content.indexOf('\n', index);
  return content.slice(start, end === -1 ? content.length : end);
}

function collectAdrFiles() {
  const adrDir = join(ROOT, 'docs/adr');
  if (!existsSync(adrDir)) return [];
  return readdirSync(adrDir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => join(adrDir, f));
}

function checkLinksInFile(file) {
  const content = readFileSync(file, 'utf8');
  // 인라인 링크 `[text](path)` + reference-style 정의 `[label]: path` 둘 다 잡는다 — 후자는 현재
  // 레포에 0건이지만(문법 자체는 유효한 Markdown) 검사 안 하면 향후 사각지대가 된다.
  const linkRe = /\]\(([^)]+)\)/g;
  const refDefRe = /^\[[^\]]+\]:\s*(\S+)/gm;
  const reported = new Set();
  const checkTarget = (raw) => {
    if (!isCheckableRepoPath(raw)) return;
    const target = raw.startsWith('/') ? join(ROOT, raw) : resolve(dirname(file), raw);
    if (reported.has(raw)) return;
    reported.add(raw);
    if (!existsSync(target)) {
      failures.push({
        check: 'dangling-reference',
        detail: `${relative(ROOT, file)}: 링크가 가리키는 경로 없음 — ${raw}`,
      });
    }
  };
  for (const m of content.matchAll(linkRe)) checkTarget(stripAnchorAndTitle(m[1]));
  for (const m of content.matchAll(refDefRe)) checkTarget(stripAnchorAndTitle(m[1]));
}

function checkBacktickPathsInFile(file) {
  const content = readFileSync(file, 'utf8');
  const backtickRe = /`([^`\n]+)`/g;
  // 실패로 확정된 경로만 dedup한다(negation-cue로 억제된 언급은 절대 여기 안 들어간다) — 그래야
  // 같은 경로가 "이제 없다"(억제)와 진짜 stale 언급 두 곳에 등장할 때, 어느 쪽이 먼저 스캔되든
  // 진짜 stale 언급이 항상 잡힌다(순서 의존적 오탐 억제 방지, test-hunter 발견).
  const reportedFailures = new Set();
  for (const m of content.matchAll(backtickRe)) {
    const raw = stripAnchorAndTitle(m[1]);
    if (!raw.includes('/')) continue;
    if (!REPO_PATH_PREFIXES.some((p) => raw.startsWith(p))) continue;
    if (!isCheckableBacktickPath(raw)) continue;
    const clean = raw.split(':')[0]; // strip trailing "file.ts:12" / "file.ts:12-34" line refs
    if (existsSync(join(ROOT, clean))) continue;
    const line = lineContaining(content, m.index);
    if (NEGATION_CUES.some((cue) => line.includes(cue))) continue; // deliberate "no longer exists" note
    if (reportedFailures.has(clean)) continue;
    reportedFailures.add(clean);
    failures.push({
      check: 'dangling-reference',
      detail: `${relative(ROOT, file)}: 백틱 경로 없음 — ${raw}`,
    });
  }
}

function checkDanglingReferences() {
  const claudeMd = join(ROOT, 'CLAUDE.md');
  const docFiles = [claudeMd, ...collectAdrFiles()].filter(existsSync);
  for (const file of docFiles) checkLinksInFile(file);
  if (existsSync(claudeMd)) checkBacktickPathsInFile(claudeMd);
}

// ── 4: SKILL.md 단어수 상한 — WARN만 (BAC-574, exit code에 반영 안 함) ───────────────────────
const SKILL_WORD_TARGET = 2000;
const SKILL_WORD_MAX = 5000;

function findSkillFiles(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      findSkillFiles(full, out);
    } else if (entry.isFile() && entry.name === 'SKILL.md') {
      out.push(full);
    }
  }
  return out;
}

function checkSkillWordCap() {
  for (const file of findSkillFiles(ROOT)) {
    const words = readFileSync(file, 'utf8').trim().split(/\s+/).filter(Boolean).length;
    if (words >= SKILL_WORD_MAX) {
      warnings.push({
        check: 'skill-word-cap',
        detail: `${relative(ROOT, file)}: ${words}단어 — 공식 상한 ${SKILL_WORD_MAX} 초과`,
      });
    } else if (words >= SKILL_WORD_TARGET) {
      warnings.push({
        check: 'skill-word-cap',
        detail: `${relative(ROOT, file)}: ${words}단어 — 공식 target ${SKILL_WORD_TARGET} 초과`,
      });
    }
  }
}

checkAdrCorpus();
checkDanglingReferences();
checkSkillWordCap();

if (asJson) {
  console.log(JSON.stringify({ failures, warnings }, null, 2));
} else {
  for (const w of warnings) console.warn(`WARN  ${w.check} — ${w.detail}`);
  for (const f of failures) console.error(`FAIL  ${f.check} — ${f.detail}`);
  if (failures.length === 0) {
    console.log(`check-docs-hygiene: OK (${warnings.length}건 WARN, 0건 FAIL)`);
  } else {
    console.error(`check-docs-hygiene: ${failures.length}건 FAIL`);
  }
}

process.exit(failures.length > 0 ? 1 : 0);
