#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { bounded, caseBound, DEFAULT_CASE_MS } from './process.mjs';
export const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export function save(path, data) { mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); writeFileSync(path, typeof data === 'string' ? data : JSON.stringify(data, null, 2) + '\n', { mode: 0o600 }); }
export const jsonl = text => text.split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
function files(root) { return existsSync(root) ? readdirSync(root, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(join(root, e.name)) : e.isFile() ? [join(root, e.name)] : []) : []; }
export function safeEnv() {
  const names = new Set(['PATH','HOME','TMPDIR','TMP','TEMP','SHELL','USER','LOGNAME','LANG','LC_ALL','LC_CTYPE','TERM','SystemRoot']);
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => names.has(k)));
  return { ...env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', LOOP_MEMORY_OFF: '1', LOOP_LEARNING_OFF: '1', LOOP_MEMORY_RECALL_ONLY: '1' };
}
export function runtimeModels(runtime, stdout, rollout) {
  const observed = runtime === 'codex' ? jsonl(rollout).filter(e => e.type === 'turn_context').map(e => e.payload?.model)
    : jsonl(stdout).flatMap(e => e.type === 'system' && e.subtype === 'init' ? [e.model] : e.type === 'assistant' ? [e.message?.model] : []);
  return [...new Set(observed.filter(v => typeof v === 'string' && v.length))];
}
// Supported auth reuse: a private, short-lived Codex auth.json copy. Never copy global
// configuration, trust grants, sessions, skills or memory. Claude uses its native OAuth/keychain
// lookup and explicitly selected session settings; unauthenticated callers stop at auth status.
export async function runNative({ runtime, executable = runtime, workspace, output, model, effort, prompt, timeoutMs = DEFAULT_CASE_MS, budgetPath, pluginDirs = [], codexProfileSetup, readonly = false, trialId = null }) {
  caseBound(timeoutMs);
  const profile = mkdtempSync(join(tmpdir(), 'paul-native-profile-'));
  chmodSync(profile, 0o700);
  const env = safeEnv(); let args, setup = null;
  try {
    if (runtime === 'codex') {
      const source = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'auth.json');
      if (!existsSync(source)) throw Error('supported file auth reuse unavailable; keyring extraction is not attempted');
      copyFileSync(source, join(profile, 'auth.json')); chmodSync(join(profile, 'auth.json'), 0o600);
      env.CODEX_HOME = profile;
      if (codexProfileSetup) setup = await codexProfileSetup({ profile, env });
      args = ['exec', ...(codexProfileSetup ? [] : ['--ignore-user-config']), '--sandbox', readonly ? 'read-only' : 'workspace-write', '--config', 'approval_policy="never"', '--config', 'features.memories=false', '--config', 'features.apps=false', '--config', 'web_search="disabled"', '--color', 'never', '--json', '-C', workspace];
      if (!codexProfileSetup) args.push('--config', 'features.plugins=false');
      // Only the fresh profile's CLI-created registration config is loaded with plugins.
      if (model) args.push('--model', model);
      if (effort) args.push('--config', `model_reasoning_effort=${JSON.stringify(effort)}`);
      args.push('-');
    } else if (runtime === 'claude') {
      // Do not use --bare: it disables supported subscription auth reuse.
      env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
      args = ['--print', '--verbose', '--output-format', 'stream-json', '--include-hook-events', '--no-session-persistence', '--setting-sources', '', '--settings', '{"autoMemoryEnabled":false}', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--no-chrome', '--permission-mode', 'dontAsk', '--tools', 'Read,Glob,Grep,Edit,Write,Bash', '--allowedTools', 'Read,Glob,Grep,Edit,Write,Bash(node test.cjs),Bash(sh verify.sh)', '--disallowedTools', 'WebFetch,WebSearch'];
      if (readonly) args.push('--disallowedTools', 'Edit,Write,Bash');
      if (model) args.push('--model', model);
      if (effort) args.push('--effort', effort);
      for (const dir of pluginDirs) args.push('--plugin-dir', dir);
    } else throw Error('runtime must be codex or claude');
    const result = await bounded(executable, args, { cwd: workspace, env, input: prompt, timeoutMs, budgetPath });
    const rollout = runtime === 'codex' ? files(join(profile, 'sessions')).filter(p => p.endsWith('.jsonl')).map(p => readFileSync(p, 'utf8')).join('\n') : '';
    save(join(output, 'stdout.jsonl'), result.stdout); save(join(output, 'stderr.txt'), result.stderr); save(join(output, 'rollout.jsonl'), rollout);
    const models = runtimeModels(runtime, result.stdout, rollout);
    const events = jsonl(result.stdout);
    const completed = runtime === 'codex' ? events.some(e => e.type === 'turn.completed') && !events.some(e => e.type === 'turn.failed') : events.some(e => e.type === 'result' && !e.is_error && e.subtype === 'success');
    const metadata = { runtime, workspace, trial_id: trialId, configured_model: model || null, configured_effort: effort || null, observed_models: models, model_status: models.length === 1 && completed ? 'observed' : 'incomplete', command: [executable, ...args], exit: result.exit, fault: result.fault, duration_ms: result.duration_ms, configured_timeout_ms: result.configured_timeout_ms, effective_timeout_ms: result.effective_timeout_ms, cleanup: result.cleanup, completed, setup, cost_usd: null, evidence: ['stdout.jsonl', 'stderr.txt', 'rollout.jsonl'].map(path => ({ path, sha256: sha(readFileSync(join(output, path))) })) };
    save(join(output, 'target.json'), metadata); return metadata;
  } finally { rmSync(profile, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const runtime = process.argv[2];
    if (!process.env.EVAL_WORKSPACE || !process.env.EVAL_STATE_DIR || !process.env.NATIVE_EVAL_BUDGET) throw Error('requires EVAL_WORKSPACE, EVAL_STATE_DIR and shared NATIVE_EVAL_BUDGET');
    const executable = process.env.NATIVE_EVAL_CLI || runtime, output = resolve(process.env.EVAL_STATE_DIR, 'native');
    const { codexPlugins } = await import('./plugins.mjs');
    const result = await runNative({ runtime, executable, workspace: resolve(process.env.EVAL_WORKSPACE), output, model: process.env.NATIVE_EVAL_MODEL, effort: process.env.NATIVE_EVAL_EFFORT, prompt: readFileSync(0, 'utf8'), timeoutMs: caseBound(Number(process.env.NATIVE_EVAL_CASE_MS || DEFAULT_CASE_MS)), budgetPath: resolve(process.env.NATIVE_EVAL_BUDGET), codexProfileSetup: runtime === 'codex' && process.env.NATIVE_EVAL_MARKETPLACE ? codexPlugins(executable, process.env.NATIVE_EVAL_MARKETPLACE, output) : undefined, pluginDirs: runtime === 'claude' && process.env.NATIVE_EVAL_PLUGINS ? JSON.parse(process.env.NATIVE_EVAL_PLUGINS) : [] });
    process.stdout.write(JSON.stringify(result) + '\n'); process.exitCode = result.exit === 0 && !result.fault ? 0 : 1;
  } catch (e) { process.stderr.write(`native adapter: ${e.message}\n`); process.exitCode = 2; }
}
