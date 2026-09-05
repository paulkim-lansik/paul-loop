#!/usr/bin/env node
// /deps-audit — Claude Code 확장(스킬·플러그인·gstack)의 유지보수 대시보드.
//   질문 3개에 답한다: (1) upstream이 관리되는가  (2) 내 설치가 최신인가  (3) 안 쓰는 건 뭔가.
//
// 채널 4갈래 매니페스트를 읽는다:
//   - 마켓플레이스 플러그인: ~/.claude/plugins/{installed_plugins,known_marketplaces}.json + ~/.claude/settings.json(enabledPlugins)
//   - skills.sh:            ~/.agents/.skill-lock.json (+ ~/.agents/.skill-provenance.json = merge-base 사이드카)
//   - gstack:               ~/.claude/skills/gstack (git repo)
//   - 레포 내장:            <repo>/.claude/skills/* (프로젝트 git 히스토리가 provenance)
// 사용량 텔레메트리: ~/.claude.json { skillUsage, pluginUsage }.
//
// 모드:
//   (기본=fast) 로컬 매니페스트 + 사용량 + gh 최신성. 클론 없음 → 주간 하트비트에 적합.
//   --deep      + skills.sh merge-base divergence 재현(캐시 클론). 내 수정 vs 단순 노후화 분류.
//   --json      기계 판독용 JSON 출력.
//   --refresh-provenance  ~/.agents/.skill-provenance.json 재생성(제거된 스킬 자동 정리·base=현재 sync 시점).
//                         `npx skills update` 후 실행해 fast 노후 판정을 정확히 유지. deep는 자가교정이라 불필요.
//
// 설계: 실패-개방(fail-open)이되 **"판단 불가(unknown)"를 "0/clean/최신"으로 붕괴시키지 않는다**. 파일 판독
//   실패·gh 조회 실패·비교 불가는 각각 별도 상태로 표면화하고, 그 상태에서는 미사용/제거/일괄업데이트 같은
//   *파괴적 권고를 침묵*시킨다(오탐이 삭제·클로버로 이어지지 않게).

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

const HOME = homedir();
const ARGS = new Set(process.argv.slice(2));
const DEEP = ARGS.has('--deep');
const JSON_OUT = ARGS.has('--json');
const REFRESH_PROV = ARGS.has('--refresh-provenance');
const NOW = Date.now();
const DAY = 86_400_000;
const STALE_USAGE_DAYS = 90;      // lastUsedAt이 이보다 오래면 "미사용 후보"
const UNMAINTAINED_DAYS = 365;    // upstream 마지막 커밋이 이보다 오래면 "관리 정체 의심"

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const CACHE = join(HOME, '.cache/deps-audit/upstream');

// 매니페스트 오염 방어: clone URL은 github https만 허용(`ext::sh -c …` 등 트랜스포트 우회 차단),
// 경로 컴포넌트는 트래버설(`..`·`/`) 금지.
const SAFE_GITHUB = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(\.git)?$/;
const safeName = (n) => typeof n === 'string' && /^[\w.-]+$/.test(n) && !n.includes('..');

// ── helpers ────────────────────────────────────────────────────────────────
const readJSON = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
const daysSince = (ms) => ms ? Math.floor((NOW - ms) / DAY) : null;
function tryExec(cmd, args, opts = {}) {
  try { return { ok: true, out: execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], ...opts }).trim() }; }
  catch (e) { return { ok: false, out: (e.stdout || '').toString().trim() }; }
}

// 사용량 텔레메트리는 *한 번만* 읽는다. null이면 "판독 불가"(≠ 빈 객체) → 미사용/제거 분석을 통째로 생략한다.
// (~/.claude.json은 Claude Code가 상시 재기록하는 큰 파일이라 부분쓰기/락으로 파싱 실패가 현실적)
const CLAUDE_JSON = readJSON(join(HOME, '.claude.json'));
const USAGE_OK = CLAUDE_JSON !== null;

let GH = null; // lazy capability probe
function ghAvailable() {
  if (GH !== null) return GH;
  GH = tryExec('gh', ['auth', 'status']).ok;
  return GH;
}
const _ghCache = new Map();
// 반환: { sha, dateMs }=성공 · { failed:true }=repo 조회 실패(404/private/rate-limit, gh는 살아있음) · null=gh 자체 부재.
// "gh 없음"과 "이 repo만 실패"를 구분해야 삭제/private repo가 '최신 미상' 빈칸으로 조용히 묻히지 않는다.
function ghRepoHead(repo) {
  if (!ghAvailable()) return null;
  if (_ghCache.has(repo)) return _ghCache.get(repo);
  const r = tryExec('gh', ['api', `repos/${repo}/commits?per_page=1`, '--jq', '.[0].sha + " " + .[0].commit.committer.date']);
  let v;
  if (r.ok && r.out) { const [sha, date] = r.out.split(' '); v = { sha, dateMs: Date.parse(date) || null }; }
  else v = { failed: true };
  _ghCache.set(repo, v);
  return v;
}
const repoSlug = (url) => url.replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/$/, '');

// ── channel loaders ──────────────────────────────────────────────────────────
function loadPlugins() {
  const installed = readJSON(join(HOME, '.claude/plugins/installed_plugins.json'))?.plugins || {};
  const markets = readJSON(join(HOME, '.claude/plugins/known_marketplaces.json')) || {};
  const settings = readJSON(join(HOME, '.claude/settings.json')) || {};
  const enabled = settings.enabledPlugins || {};
  const usage = CLAUDE_JSON?.pluginUsage || {};
  const rows = [];
  for (const [key, arr] of Object.entries(installed)) {
    const [name, market] = key.split('@');
    const inst = Array.isArray(arr) ? arr[0] : arr;
    const mkt = markets[market];
    const u = usage[key] || {};
    rows.push({
      channel: 'plugin', key, name, market,
      version: inst?.version, installedSha: inst?.gitCommitSha,
      lastUpdatedMs: Date.parse(inst?.lastUpdated) || null,
      enabled: enabled[key] === true,
      autoUpdate: mkt?.autoUpdate === true,
      marketRepo: mkt?.source?.repo || null,
      usageCount: u.usageCount ?? 0, lastUsedMs: u.lastUsedAt || null,
    });
  }
  return rows;
}

function loadSkillsSh() {
  const lock = readJSON(join(HOME, '.agents/.skill-lock.json'));
  if (!lock?.skills) return [];
  const prov = readJSON(join(HOME, '.agents/.skill-provenance.json'))?.skills || {};
  const usage = CLAUDE_JSON?.skillUsage || {};
  return Object.entries(lock.skills).map(([name, m]) => {
    const u = usage[name] || {};
    const p = prov[name] || {};
    return {
      channel: 'skills.sh', name, source: m.source, sourceUrl: m.sourceUrl, skillPath: m.skillPath,
      installedAtMs: Date.parse(m.installedAt) || null, updatedAtMs: Date.parse(m.updatedAt) || null, updatedAt: m.updatedAt,
      installBaseCommit: p.installBaseCommit || null,
      usageCount: u.usageCount ?? 0, lastUsedMs: u.lastUsedAt || null,
    };
  });
}

function loadGstack() {
  const dir = join(HOME, '.claude/skills/gstack');
  if (!existsSync(join(dir, '.git'))) return null;
  const version = existsSync(join(dir, 'VERSION')) ? readFileSync(join(dir, 'VERSION'), 'utf8').trim() : '?';
  const headRes = tryExec('git', ['-C', dir, 'rev-parse', '--short', 'HEAD']);
  const head = headRes.ok && headRes.out ? headRes.out : null; // 실패 시 null → 거짓 "최신" 방지
  const origin = tryExec('git', ['-C', dir, 'remote', 'get-url', 'origin']).out;
  const lastCommitMs = Date.parse(tryExec('git', ['-C', dir, 'log', '-1', '--format=%cI']).out) || null;
  return { channel: 'gstack', dir, version, head, origin, lastCommitMs };
}

function loadProjectSkills() {
  const dir = join(PROJECT_DIR, '.claude/skills');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => { try { return statSync(join(dir, n)).isDirectory(); } catch { return false; } })
    .map((name) => {
      const rel = `.claude/skills/${name}`;
      const logRes = tryExec('git', ['-C', PROJECT_DIR, 'log', '--oneline', '--', rel]);
      // git 조회 실패(레포 아님·git 부재)를 "0커밋/저자"로 오표시하지 않는다 → commits=null(미상).
      if (!logRes.ok) return { channel: 'project', name, commits: null, vendored: null, lastCommitMs: null };
      const commits = logRes.out.split('\n').filter(Boolean).length;
      const last = tryExec('git', ['-C', PROJECT_DIR, 'log', '-1', '--format=%cI', '--', rel]).out;
      const firstMsg = tryExec('git', ['-C', PROJECT_DIR, 'log', '--reverse', '--format=%s', '--', rel]).out.split('\n')[0] || '';
      // 벤더/저자 판정 기준 = 첫 커밋 메시지가 /vendor/i 매칭인지(커밋 수와 무관).
      const vendored = /vendor/i.test(firstMsg);
      return { channel: 'project', name, commits, vendored, lastCommitMs: Date.parse(last) || null };
    });
}

// ── deep divergence (merge-base 재현) ────────────────────────────────────────
// upstream 캐시 클론(있으면 fetch). URL은 github https만 허용(트랜스포트 우회 RCE 차단).
function ensureClones(skillsSh) {
  mkdirSync(CACHE, { recursive: true });
  for (const url of [...new Set(skillsSh.map((s) => s.sourceUrl))].filter((u) => SAFE_GITHUB.test(u))) {
    const d = join(CACHE, repoSlug(url).replace('/', '__'));
    if (existsSync(join(d, '.git'))) tryExec('git', ['-C', d, 'fetch', '-q', '--depth=1000']);
    else tryExec('git', ['clone', '-q', '--depth=1000', url, d]);
  }
}
const cloneDir = (s) => join(CACHE, repoSlug(s.sourceUrl).replace('/', '__'));
// base = 로컬 sync 시점(lock.updatedAt)의 upstream 커밋. updatedAt은 skills.sh가 sync마다 갱신하는 *라이브* 값이라
// 사이드카 캐시보다 authoritative → `skills update` 뒤 사이드카가 stale해도 자가교정(가짜 🟡 재발 방지).
// 경로 개편·삭제 스킬도 과거 커밋을 정확히 찾는다(historical path lookup). 실패 시 null.
function upstreamBaseAt(s) {
  const out = tryExec('git', ['-C', cloneDir(s), 'log', '-1', '--format=%H', `--before=${s.updatedAt}`, '--', dirname(s.skillPath)]).out;
  return /^[0-9a-f]{40}$/.test(out) ? out : null;
}

function deepDivergence(skillsSh) {
  ensureClones(skillsSh);
  for (const s of skillsSh) {
    if (!SAFE_GITHUB.test(s.sourceUrl) || !safeName(s.name)) { s.divergence = 'url-unsafe'; continue; }
    const d = cloneDir(s);
    const pathdir = dirname(s.skillPath);
    const local = join(HOME, '.agents/skills', s.name);
    // updatedAt 우선(자가교정), 실패 시 사이드카 폴백.
    const base = upstreamBaseAt(s) || (/^[0-9a-f]{7,40}$/.test(s.installBaseCommit || '') ? s.installBaseCommit : null);
    // 인자 주입 방지: base는 커밋 sha만 허용(`-`로 시작하는 값이 git 옵션으로 오파싱되는 것 차단)
    if (!base || !/^[0-9a-f]{7,40}$/.test(base)) { s.divergence = 'base-unresolved'; continue; }
    // base 트리 추출 → local과 비교 = 순수 내 수정분. argv-form 파이핑(셸 없음): 매니페스트 문자열을 셸에 넣지 않는다.
    // 추출 전 tmp를 비운다 — 이전 실행의 다른 base 잔존 파일이 diff를 부풀려 가짜 🟡을 만드는 것 방지(CR-F2).
    const tmp = join(CACHE, '.base', s.name);
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
    const archive = spawnSync('git', ['-C', d, 'archive', base, '--', pathdir], { maxBuffer: 256 << 20 });
    if (archive.status === 0 && archive.stdout?.length) spawnSync('tar', ['-x', '-C', tmp], { input: archive.stdout });
    const baseFolder = join(tmp, pathdir);
    if (!existsSync(baseFolder)) { s.divergence = 'base-extract-fail'; continue; }
    // diffDirs=null → 비교 불가(로컬 폴더 없음/ git 오류). "차이 0"과 섞지 않는다 → mine-unknown(안전측: 덮어쓰기 권고 안 함).
    const mineOut = diffDirs(baseFolder, local);
    if (mineOut === null) { s.divergence = 'mine-unknown'; continue; }
    const mine = numstat(mineOut);
    const head = tryExec('git', ['-C', d, 'rev-parse', 'HEAD']).out;
    const up = numstat(tryExec('git', ['-C', d, 'diff', '--numstat', `${base}..${head}`, '--', pathdir]).out);
    s.mine = mine; s.upstreamDelta = up;
    s.divergence = mine.files === 0 && up.files === 0 ? 'clean'
      : mine.files === 0 ? 'stale-only'      // 내 수정 없음 → 안전 업데이트
      : 'my-edits';                          // 보존 대상
  }
}

// --refresh-provenance: 사이드카를 현재 lock + upstream 상태로 재생성. lock에 없는(제거된) 스킬은 자동 정리,
// base = updatedAt 시점 커밋. `npx skills update` 후 실행해 fast 노후 판정을 최신 상태로 되돌린다.
function refreshProvenance(skillsSh) {
  ensureClones(skillsSh);
  const prior = readJSON(join(HOME, '.agents/.skill-provenance.json'))?.skills || {}; // 조회 실패 시 보존용
  const validSha = (x) => (/^[0-9a-f]{7,40}$/.test(x || '') ? x : null);
  const prov = { stampedAt: new Date().toISOString(), note: 'deps-audit --refresh-provenance 재생성. base=lock.updatedAt 시점 upstream 커밋(로컬 sync 기준). 조회 실패 스킬은 기존값 보존.', skills: {} };
  let resolved = 0;
  for (const s of skillsSh) {
    if (!SAFE_GITHUB.test(s.sourceUrl) || !safeName(s.name)) continue;
    const fresh = upstreamBaseAt(s);
    if (fresh) resolved++;
    const head = tryExec('git', ['-C', cloneDir(s), 'rev-parse', 'HEAD']).out;
    prov.skills[s.name] = {
      source: s.source, skillPath: s.skillPath, updatedAt: s.updatedAt,
      // 조회 실패 시 기존 사이드카 값 보존 — 좋은 base를 null로 덮어쓰지 않는다(파괴적 fail-open 방지).
      installBaseCommit: fresh || validSha(prior[s.name]?.installBaseCommit),
      upstreamHeadAtStamp: /^[0-9a-f]{40}$/.test(head) ? head : (prior[s.name]?.upstreamHeadAtStamp || null),
    };
  }
  // 전면 실패(네트워크/클론 다운으로 아무것도 새로 못 구함) → 기존 파일 보존, 성공 가장 안 함.
  const targets = skillsSh.filter((s) => SAFE_GITHUB.test(s.sourceUrl) && safeName(s.name)).length;
  if (targets > 0 && resolved === 0) return { written: false, degraded: true, count: 0 };
  try {
    mkdirSync(join(HOME, '.agents'), { recursive: true });
    writeFileSync(join(HOME, '.agents/.skill-provenance.json'), JSON.stringify(prov, null, 2));
  } catch (e) {
    return { written: false, count: 0, error: String(e?.message ?? e).split('\n')[0] };
  }
  return { written: true, count: Object.keys(prov.skills).length };
}
// 두 디렉토리 diff numstat 텍스트. null = 비교 불가(한쪽 부재 or git 실패). '' = 차이 없음(exit 0). exit 1 = 차이(정상).
function diffDirs(a, b) {
  if (!existsSync(a) || !existsSync(b)) return null;
  try { return execFileSync('git', ['diff', '--no-index', '--numstat', a, b], { encoding: 'utf8', maxBuffer: 64 << 20 }); }
  catch (e) { return e.status === 1 ? (e.stdout || '').toString() : null; }
}
function numstat(out) {
  let files = 0, add = 0, rem = 0;
  for (const l of out.trim().split('\n').filter(Boolean)) {
    const [a, r] = l.split('\t'); if (a === undefined) continue;
    files++; add += a === '-' ? 0 : +a || 0; rem += r === '-' ? 0 : +r || 0;
  }
  return { files, add, rem };
}
// divergence 정렬 우선순위: 주의 필요(보존·판정불가) > 노후화 > 나머지
const DIV_RANK = { 'my-edits': 3, 'mine-unknown': 3, 'url-unsafe': 3, 'base-unresolved': 2.5, 'base-extract-fail': 2.5, 'stale-only': 2, 'clean': 0 };
const rankDiv = (s) => DIV_RANK[s.divergence] || 0;
const DIV_LABEL = { 'my-edits': '🟡보존', 'stale-only': '🟠업데이트가능', clean: '🟢', 'mine-unknown': '⚠️비교불가', 'base-unresolved': '⚠️base미상', 'base-extract-fail': '⚠️추출실패', 'url-unsafe': '⛔URL거부' };
const DIV_UNKNOWN = new Set(['mine-unknown', 'base-unresolved', 'base-extract-fail', 'url-unsafe']);

// ── freshness + staleness 판정 ────────────────────────────────────────────────
function annotateFreshness(skillsSh, plugins, gstack) {
  for (const s of skillsSh) {
    const head = ghRepoHead(repoSlug(s.sourceUrl));
    s.upstreamStatus = head === null ? 'no-gh' : head.failed ? 'gone' : 'ok';
    s.upstreamHeadSha = head?.sha || null;
    s.upstreamLastCommitDays = daysSince(head?.dateMs);
    s.stale = s.installBaseCommit && head?.sha ? !head.sha.startsWith(s.installBaseCommit) && s.installBaseCommit.slice(0, 8) !== head.sha.slice(0, 8) : null;
  }
  for (const p of plugins) {
    if (!p.marketRepo) continue;
    const head = ghRepoHead(p.marketRepo);
    p.marketLastCommitDays = daysSince(head?.dateMs);
  }
  if (gstack?.origin) {
    const head = ghRepoHead(repoSlug(gstack.origin));
    gstack.upstreamLastCommitDays = daysSince(head?.dateMs);
    // 로컬 head·upstream sha 둘 다 있을 때만 판정. 하나라도 없으면 null(?) — 빈 문자열 startsWith 거짓 "최신" 방지.
    gstack.behind = head?.sha && gstack.head ? !head.sha.startsWith(gstack.head) : null;
  }
}

// 하트비트 스로틀용 실행 스탬프. 셸 없이 직접 기록. --json 조기반환 전에도 찍히도록 별도 함수.
function writeStamp() {
  try {
    const loopDir = join(PROJECT_DIR, '.loop');
    mkdirSync(loopDir, { recursive: true });
    writeFileSync(join(loopDir, 'deps-audit.last'), String(NOW));
  } catch { /* fail-open */ }
}

// ── render ────────────────────────────────────────────────────────────────────
function main() {
  const plugins = loadPlugins();
  const skillsSh = loadSkillsSh();
  if (REFRESH_PROV) {
    const r = refreshProvenance(skillsSh);
    if (r.written) console.log(`✓ provenance 재생성: ${r.count}개 스킬 → ~/.agents/.skill-provenance.json (lock에 없는 스킬 자동 정리)`);
    else if (r.degraded) console.log('⚠️ provenance 미갱신 — upstream 조회 전면 실패(네트워크/클론 down). 기존 사이드카 보존.');
    else console.log(`⚠️ provenance 쓰기 실패(기존 보존): ${r.error || ''}`);
    writeStamp();
    return;
  }
  const gstack = loadGstack();
  const projectSkills = loadProjectSkills();
  annotateFreshness(skillsSh, plugins, gstack);
  if (DEEP) deepDivergence(skillsSh);
  writeStamp(); // fast/deep/json 모든 실행이 하트비트를 리셋(--json도 "돌렸음"으로 카운트)

  if (JSON_OUT) { console.log(JSON.stringify({ usageAvailable: USAGE_OK, plugins, skillsSh, gstack, projectSkills }, null, 2)); return; }

  const net = ghAvailable();
  const H = (t) => `\n\x1b[1m${t}\x1b[0m`;
  const line = (s) => console.log(s);
  line(`\x1b[1m════ /deps-audit ${DEEP ? '(deep)' : '(fast)'} ════\x1b[0m  ${net ? 'gh:on' : 'gh:off(최신성 unknown)'}  ${USAGE_OK ? '' : 'usage:판독불가 '}${new Date(NOW).toISOString().slice(0, 16)}`);

  // 1) 플러그인
  line(H('1) 마켓플레이스 플러그인'));
  for (const p of plugins.sort((a, b) => Number(b.enabled) - Number(a.enabled))) {
    const state = p.enabled ? '✅' : '⛔';
    const fresh = p.marketLastCommitDays == null ? '' : `upstream ${p.marketLastCommitDays}d전`;
    const used = !USAGE_OK ? 'use?' : p.usageCount > 0 ? `use ${p.usageCount}` : (p.lastUsedMs ? `use0/last ${daysSince(p.lastUsedMs)}d` : 'use0');
    const flag = !USAGE_OK ? ''
      : !p.enabled && p.usageCount === 0 ? ' 🗑️ 비활성+미사용→제거후보'
      : (p.enabled && p.usageCount === 0 ? ' ⓘ 0직접호출(스킬/MCP경유일 수 있음)' : '');
    line(`  ${state} ${p.name.padEnd(26)} v${(p.version || '?').padEnd(8)} ${used.padEnd(16)} ${fresh}${flag}`);
  }

  // 2) skills.sh
  line(H('2) skills.sh 스킬') + (DEEP ? '  [내수정/노후화 분류]' : '  (--deep로 divergence 분류)'));
  for (const s of skillsSh.sort((a, b) => (rankDiv(b) - rankDiv(a)) || (b.usageCount - a.usageCount))) {
    const used = !USAGE_OK ? 'use?' : s.usageCount > 0 ? `use ${s.usageCount}` : (s.lastUsedMs ? `use0/${daysSince(s.lastUsedMs)}d` : 'use0');
    const fresh = s.upstreamStatus === 'gone' ? '조회✗' : s.upstreamLastCommitDays == null ? '' : `up ${s.upstreamLastCommitDays}d`;
    const staleTag = s.stale === true ? '노후' : s.stale === false ? '최신' : '?';
    const div = DEEP ? (DIV_LABEL[s.divergence] || '') : '';
    const mine = DEEP && s.mine?.files ? ` 내수정 ${s.mine.files}f+${s.mine.add}/-${s.mine.rem}` : '';
    const unused = USAGE_OK && s.usageCount === 0 && (!s.lastUsedMs || daysSince(s.lastUsedMs) > STALE_USAGE_DAYS) ? ' 🗑️' : '';
    line(`  ${s.name.padEnd(28)} ${used.padEnd(14)} ${staleTag.padEnd(4)} ${fresh.padEnd(8)} ${div}${mine}${unused}`);
  }

  // 3) gstack
  if (gstack) {
    line(H('3) gstack'));
    const b = gstack.behind === true ? '뒤처짐(→ /gstack-upgrade)' : gstack.behind === false ? '최신' : '?';
    line(`  v${gstack.version}  HEAD ${gstack.head || '?'}  ${b}  ${gstack.upstreamLastCommitDays != null ? `upstream ${gstack.upstreamLastCommitDays}d전` : ''}`);
  }

  // 4) 레포 내장
  line(H('4) 레포 내장 프로젝트 스킬  (provenance = 프로젝트 git)'));
  for (const s of projectSkills.sort((a, b) => Number(a.vendored) - Number(b.vendored) || (b.commits || 0) - (a.commits || 0))) {
    if (s.commits === null) { line(`  ? ${s.name.padEnd(28)} (git 조회 실패 — 미상)`); continue; }
    const native = s.vendored ? `벤더(${s.commits}커밋)` : `저자(${s.commits}커밋)`;
    line(`  ${(s.vendored ? '  ' : '★ ') + s.name.padEnd(28)} ${native.padEnd(12)} ${s.lastCommitMs ? daysSince(s.lastCommitMs) + 'd전' : ''}`);
  }

  // 5) 권고
  line(H('▶ 권고 액션'));
  if (USAGE_OK) {
    const rmPlugins = plugins.filter((p) => !p.enabled && p.usageCount === 0);
    const rmSkills = skillsSh.filter((s) => s.usageCount === 0 && (!s.lastUsedMs || daysSince(s.lastUsedMs) > STALE_USAGE_DAYS));
    if (rmPlugins.length) line(`  🗑️ 제거후보 플러그인(비활성+미사용): ${rmPlugins.map((p) => p.name).join(', ')}`);
    if (rmSkills.length) line(`  🗑️ 제거후보 스킬(미사용 ${STALE_USAGE_DAYS}d+): ${rmSkills.map((s) => s.name).join(', ')}`);
  } else {
    line('  ⚠️ 사용량 텔레메트리(~/.claude.json) 판독 불가 → 미사용/제거 분석 생략(오탐→오삭제 방지).');
  }
  const gone = skillsSh.filter((s) => s.upstreamStatus === 'gone');
  const unmaintained = skillsSh.filter((s) => s.upstreamLastCommitDays > UNMAINTAINED_DAYS);
  if (unmaintained.length) line(`  ⚠️ upstream 관리정체 의심(>${UNMAINTAINED_DAYS}d): ${unmaintained.map((s) => s.name).join(', ')}`);
  if (gone.length) line(`  ⚠️ upstream 조회 실패(삭제·private·rate-limit 의심): ${gone.map((s) => s.name).join(', ')}`);
  if (DEEP) {
    const myEdits = skillsSh.filter((s) => s.divergence === 'my-edits');
    const staleOnly = skillsSh.filter((s) => s.divergence === 'stale-only');
    const unknown = skillsSh.filter((s) => DIV_UNKNOWN.has(s.divergence));
    line(`  🟡 보존필요(내수정): ${myEdits.length ? myEdits.map((s) => s.name).join(', ') : '없음'}`);
    line(`  🟠 안전 일괄업데이트(내수정 없음): ${staleOnly.length}개`);
    if (unknown.length) line(`  ⚠️ divergence 판정 불가(수동 확인): ${unknown.map((s) => s.name).join(', ')}`);
  } else {
    line(`  ⓘ divergence(내수정 vs 노후화) 분류는 --deep 로 실행.`);
  }
  if (!net) line(`  ⚠️ gh 없음/미인증 → upstream 최신성 미측정. \`gh auth login\` 후 재실행.`);
}

main();
