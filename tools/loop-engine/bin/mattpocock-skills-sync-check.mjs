#!/usr/bin/env node
// 값싼 선행 체크 — mattpocock/skills(우리가 vendor해 쓰는 스킬들의 upstream)에 마지막 확인 이후 새
// 커밋이 있는지만 본다. gh api 호출 1~2회, LLM/서브에이전트 없음. `/mattpocock-skills-sync` 스킬이
// 이 스크립트로 "무거운 다중에이전트 비교분석을 돌릴 가치가 있는가"를 먼저 판단한다.
//
// 사용:
//   node mattpocock-skills-sync-check.mjs            # 상태 출력만
//   node mattpocock-skills-sync-check.mjs --stamp <sha>  # 확인 완료로 기록 (heartbeat 타이머도 같이 갱신)
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';

const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const stateFile = join(projectDir, '.loop', 'mattpocock-skills-sync.json');
const REPO = 'mattpocock/skills';

function readState() {
  if (!existsSync(stateFile)) return {};
  try {
    return JSON.parse(readFileSync(stateFile, 'utf8'));
  } catch {
    return {};
  }
}

function writeState(next) {
  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, JSON.stringify(next, null, 2));
}

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

const stampArgIdx = process.argv.indexOf('--stamp');
if (stampArgIdx !== -1) {
  const sha = process.argv[stampArgIdx + 1];
  if (!sha) {
    console.error('--stamp 뒤에 SHA가 필요합니다');
    process.exit(1);
  }
  const state = readState();
  writeState({ ...state, lastSeenSha: sha, lastCheckedAt: Date.now() });
  console.log(`STAMPED ${sha}`);
  process.exit(0);
}

let currentSha;
try {
  currentSha = gh(['api', `repos/${REPO}/commits/HEAD`, '--jq', '.sha']);
} catch {
  console.log('UNKNOWN — gh api 실패(미인증/네트워크/rate-limit). 판단 보류.');
  process.exit(2);
}

const { lastSeenSha } = readState();

if (!lastSeenSha) {
  console.log(`FIRST_RUN ${currentSha}`);
  process.exit(0);
}

if (lastSeenSha === currentSha) {
  console.log(`UNCHANGED ${currentSha}`);
  process.exit(0);
}

let count = '?';
try {
  count = gh(['api', `repos/${REPO}/compare/${lastSeenSha}...${currentSha}`, '--jq', '.total_commits']);
} catch {
  /* best-effort — 카운트 없이도 CHANGED는 알 수 있다 */
}

console.log(`CHANGED ${lastSeenSha} ${currentSha} ${count}`);
process.exit(0);
