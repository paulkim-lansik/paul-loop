#!/usr/bin/env node
// bin/check-module-size.mjs — BAC-754 (ported from glucofit-partners' tools/check-module-size.mjs,
// originally BAC-629 — ouroboros O8 채택, see that repo's docs/research/2026-08-04-ouroboros-
// benchmarking.md §4.4/§6 for the source study).
//
// module-size ratchet: threshold(기본 2000줄)를 넘는 모듈은 "줄기만 가능"으로 고정한다. ouroboros
// 실측(2,000줄 초과 모듈 26개=소스 35.3%, 리뷰 중 PR이 324줄 몰래 성장)에서 코디파이된 게이트 —
// 우리는 사고 전에 도입한다.
//
//   1. growth 위반: threshold를 넘는 파일의 현재 줄수가 baseline에 기록된 한도(없으면 0)보다 크면
//      FAIL. baseline에 없던 파일이 새로 threshold를 넘는 것도 growth(한도 0 초과)로 잡힌다.
//   2. 자가변조(self-modification) 위반: 이 PR이 제안하는 baseline(작업트리)이 base-ref 시점의
//      baseline보다 **완화**되어 있으면(threshold 상향, 개별 모듈 한도 상향, 신규 모듈 한도 추가)
//      FAIL — 같은 커밋에서 정책 문구를 완화해 위반을 숨기는 경로를 막는다. base-ref에 baseline
//      파일이 아예 없었다면(최초 도입) 비교 대상이 없으므로 스킵(부트스트랩).
//
// Exit 0 = 위반 없음. Exit 1 = growth 또는 자가변조 위반. --json으로 기계가독 결과.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_BASELINE_REL = 'tools/module-size-baseline.json';
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  '.next',
  '.turbo',
  '.git',
  'drizzle',
  'coverage',
  '.gstack',
]);
const SKIP_PATH_SEGMENTS = ['/migrations/', '/generated/'];
const SOURCE_EXT = /\.(ts|tsx)$/;
const EXCLUDE_SUFFIX = /\.(d\.ts|test\.ts|test\.tsx|spec\.ts|spec\.tsx)$/;

function parseArgs(argv) {
  const opts = {
    root: undefined,
    baselinePath: undefined,
    baseRef: undefined,
    baseBaselineFile: undefined,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') opts.root = argv[++i];
    else if (a === '--baseline') opts.baselinePath = argv[++i];
    else if (a === '--base-ref') opts.baseRef = argv[++i];
    else if (a === '--base-baseline') opts.baseBaselineFile = argv[++i];
    else if (a === '--json') opts.json = true;
  }
  return opts;
}

function resolveRoot(argv) {
  if (argv.root) return resolve(argv.root);
  return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
}

function countLines(filePath) {
  const content = readFileSync(filePath, 'utf8');
  if (content.length === 0) return 0;
  const lines = content.split('\n');
  // trailing newline이면 split이 만드는 마지막 빈 요소는 줄이 아님
  return lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
}

function walkSourceFiles(root) {
  const out = [];
  (function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(join(dir, entry.name));
        continue;
      }
      if (!entry.isFile()) continue; // 심볼릭 링크는 의도적으로 스킵(추적 밖 콘텐츠를 끌어들이거나 순환 링크 위험 회피)
      const full = join(dir, entry.name);
      const rel = relative(root, full).split('\\').join('/');
      if (!SOURCE_EXT.test(entry.name)) continue;
      if (EXCLUDE_SUFFIX.test(entry.name)) continue;
      if (SKIP_PATH_SEGMENTS.some((seg) => `/${rel}`.includes(seg))) continue;
      out.push(rel);
    }
  })(root);
  return out;
}

function loadJson(text) {
  const parsed = JSON.parse(text);
  return { threshold: parsed.threshold, modules: parsed.modules ?? {} };
}

function loadWorkingBaseline(root, baselinePath) {
  const abs = resolve(root, baselinePath);
  if (!existsSync(abs)) return { threshold: 2000, modules: {} };
  return loadJson(readFileSync(abs, 'utf8'));
}

// base-ref 시점의 baseline — 자가변조 비교 대상. 없으면(최초 도입 등) null(부트스트랩, 비교 스킵).
//
// "파일이 그 시점에 없었음(진짜 부트스트랩)"과 "그 외 모든 실패(잘못된 ref·git 오류·손상된 JSON)"를
// 반드시 구분한다 — 뭉뚱그려 catch하면 자가변조 체크 자체가 조용히 꺼진다(이 게이트의 존재 이유가
// 정확히 이걸 막는 것이므로 fail-open이 가장 나쁜 결과, 리뷰에서 실증됨). ref가 아예 resolve 안 되면
// 에러로 드러내고, ref는 유효한데 그 경로만 없으면(정상 부트스트랩) null.
function loadBaseBaseline({ root, baselinePath, baseRef, baseBaselineFile }) {
  if (baseBaselineFile) {
    if (!existsSync(baseBaselineFile)) return null;
    return loadJson(readFileSync(baseBaselineFile, 'utf8'));
  }
  if (!baseRef) return null;

  try {
    execFileSync('git', ['rev-parse', '--verify', `${baseRef}^{commit}`], {
      cwd: root,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
  } catch {
    throw new Error(
      `--base-ref '${baseRef}'가 resolve되지 않습니다 (fetch-depth 부족 등 CI 배선 오류로 의심됨) — ` +
        '자가변조 체크를 조용히 건너뛰지 않고 에러로 중단합니다.',
    );
  }

  let text;
  try {
    text = execFileSync('git', ['show', `${baseRef}:${baselinePath}`], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const stderr = err.stderr?.toString() ?? '';
    if (/does not exist in|exists on disk, but not in/.test(stderr)) {
      return null; // base-ref는 유효하지만 그 시점에 baseline 파일이 없었음 — 정상 부트스트랩
    }
    throw new Error(
      `--base-ref '${baseRef}':${baselinePath} 읽기 실패(부트스트랩 아님) — ${stderr.trim() || err.message}`,
    );
  }

  try {
    return loadJson(text);
  } catch (err) {
    throw new Error(
      `--base-ref '${baseRef}':${baselinePath}의 JSON이 손상되었습니다 — ${err.message}`,
    );
  }
}

function checkSelfModification(working, base) {
  const violations = [];
  if (!base) return violations; // 부트스트랩 — 비교 대상 없음

  if (working.threshold > base.threshold) {
    violations.push({
      kind: 'threshold-relaxed',
      detail: `threshold ${base.threshold} → ${working.threshold}`,
    });
  }
  for (const [path, limit] of Object.entries(working.modules)) {
    const baseLimit = base.modules[path];
    if (baseLimit === undefined) {
      violations.push({
        kind: 'new-module-entry',
        path,
        // 주의: 이 레포는 develop→main 릴리스 PR에서만 CI가 돈다(ADR-0053) — 즉 이 게이트가 도는
        // 유일한 PR이 항상 "같은 PR" 판정 대상이라, 신규 오버사이즈 모듈을 정상적으로 등록할 자동화
        // 경로가 없다. 실제로 필요해지면 브랜치 보호를 사람이 수동으로 완화하는 것 외엔 방법이 없다
        // (CLAUDE.md §8 비상 우회 절차와 동일 계열) — "별도 리뷰"는 그 수동 경로를 가리킨다.
        detail: `base-ref에 없던 모듈 한도 신설: ${limit}줄 (같은 PR에서 등록 불가 — 사람의 수동 브랜치보호 우회 필요)`,
      });
    } else if (limit > baseLimit) {
      violations.push({
        kind: 'module-limit-relaxed',
        path,
        detail: `${baseLimit} → ${limit}`,
      });
    }
  }
  return violations;
}

function checkGrowth(root, working) {
  const violations = [];
  const files = walkSourceFiles(root);
  for (const rel of files) {
    const lines = countLines(join(root, rel));
    if (lines <= working.threshold) continue;
    const limit = working.modules[rel] ?? 0;
    if (lines > limit) {
      violations.push({ kind: 'growth', path: rel, lines, limit });
    }
  }
  return violations;
}

function main() {
  const argv = parseArgs(process.argv.slice(2));
  const root = resolveRoot(argv);
  const baselinePath = argv.baselinePath ?? DEFAULT_BASELINE_REL;

  let working;
  let base;
  try {
    working = loadWorkingBaseline(root, baselinePath);
    base = loadBaseBaseline({
      root,
      baselinePath,
      baseRef: argv.baseRef,
      baseBaselineFile: argv.baseBaselineFile,
    });
  } catch (err) {
    if (argv.json) {
      console.log(JSON.stringify({ ok: false, violations: [], error: err.message }));
    } else {
      console.error(`FAIL[wiring]: ${err.message}`);
    }
    process.exit(1);
  }

  const selfMod = checkSelfModification(working, base);
  const growth = checkGrowth(root, working);
  const violations = [...selfMod, ...growth];
  const ok = violations.length === 0;

  if (argv.json) {
    console.log(JSON.stringify({ ok, violations }));
  } else if (ok) {
    console.log('PASS: module-size ratchet — 위반 없음');
  } else {
    for (const v of violations) {
      if (v.kind === 'growth') {
        console.error(
          `FAIL[growth]: ${v.path} — ${v.lines}줄 (한도 ${v.limit}줄 초과, threshold=${working.threshold}). ` +
            '초과 모듈은 이 PR에서 줄어들거나 그대로여야 합니다.',
        );
      } else {
        console.error(`FAIL[${v.kind}]: ${v.path ?? '(threshold)'} — ${v.detail}`);
      }
    }
  }

  process.exit(ok ? 0 : 1);
}

// `import.meta.url`은 percent-encoding된다(공백·비ASCII → %XX). `file://${process.argv[1]}`는 raw
// OS 경로라, 체크아웃 경로에 공백이나 한글이 하나라도 있으면 두 문자열이 조용히 어긋나 아래 CLI
// 블록이 통째로 실행되지 않는다 — 출력 0줄에 exit 0이라, 호출자는 "게이트 통과"로 읽는다(실측:
// 같은 파일을 공백 있는 경로에 두면 출력이 사라진다). pathToFileURL()이 argv[1]을 같은 방식으로
// 정규화한다. 앞의 `process.argv[1] &&`는 argv[1]이 없는 맥락(`node -e`, 워커)에서 pathToFileURL이
// 던지지 않게 한다 — 리졸버/게이트는 어떤 맥락에서도 import만으로 죽으면 안 된다. (BAC-699 → BAC-792)
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
