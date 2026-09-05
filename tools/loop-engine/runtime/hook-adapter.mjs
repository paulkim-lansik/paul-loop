#!/usr/bin/env node
// Generated Codex packages copy this unchanged. Never enables/trusts/installs a hook.
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const denyOutput = (reason) => JSON.stringify({ hookSpecificOutput: {
  hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason,
} });
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const knownKeys = (value, keys) => Object.keys(value).every(key => keys.includes(key));
const optionalType = (value, key, type) => !(key in value) || typeof value[key] === type;
const invalidOutput = () => denyOutput('[paul-loop codex] Invalid PreToolUse hook output: expected an explicit recognized decision schema. No tool execution was approved.');
export function adaptOutput(event, stdout) {
  if (typeof stdout !== 'string') return event === 'PreToolUse' ? invalidOutput() : '';
  if (!stdout.trim()) return ''; // the sole non-decision defer form accepted from source guards
  let value;
  try { value = JSON.parse(stdout); } catch { return event === 'PreToolUse' ? invalidOutput() : stdout; }
  if (event !== 'PreToolUse') return JSON.stringify(value);
  const decision = value?.hookSpecificOutput;
  if (!object(value) || !knownKeys(value, ['hookSpecificOutput', 'continue', 'stopReason', 'suppressOutput', 'systemMessage']) ||
      !optionalType(value, 'continue', 'boolean') || !optionalType(value, 'suppressOutput', 'boolean') ||
      !optionalType(value, 'stopReason', 'string') || !optionalType(value, 'systemMessage', 'string') ||
      !object(decision) || !knownKeys(decision, ['hookEventName', 'permissionDecision', 'permissionDecisionReason', 'updatedInput', 'additionalContext']) ||
      decision.hookEventName !== 'PreToolUse' || !['allow', 'deny', 'ask'].includes(decision.permissionDecision) ||
      !optionalType(decision, 'permissionDecisionReason', 'string') || !optionalType(decision, 'additionalContext', 'string') ||
      ('updatedInput' in decision && !object(decision.updatedInput))) return invalidOutput();
  if (value.continue === false && decision.permissionDecision !== 'deny') {
    return denyOutput('[paul-loop codex] Hook requested a stop; no tool execution was approved.');
  }
  if (decision.permissionDecision === 'ask') {
    decision.permissionDecision = 'deny';
    decision.permissionDecisionReason =
      `Human review required: Codex does not implement hook ask decisions. Separate review alone does not make an identical retry pass; this adapter records no approval. A human must use a supported, explicitly authorized host execution or configuration route for this action. Do not automatically retry or bypass the denial. ${decision.permissionDecisionReason || ''}`;
  }
  return JSON.stringify(value);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const eventFailure = (event, message) => {
    if (event === 'PreToolUse') {
      console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: event, permissionDecision: 'deny', permissionDecisionReason: message } }));
    } else {
      console.error(message);
      process.exitCode = event === 'Stop' ? 2 : 1;
    }
  };
  let payload;
  try { payload = JSON.parse(readFileSync(0, 'utf8')); }
  catch { console.error('[paul-loop codex] invalid hook input'); process.exit(2); }
  const event = payload.hook_event_name;
  try {
    const capabilities = JSON.parse(readFileSync(join(root, 'runtime', 'capabilities.json'), 'utf8'));
    if (capabilities.codex.unsupportedEvents.includes(event)) throw new Error(`unsupported event: ${event}`);
    const relTarget = process.argv[2];
    if (typeof relTarget !== 'string' || !relTarget.startsWith('hooks/')) throw new Error('invalid hook target');
    const target = realpathSync(join(root, relTarget));
    const rel = relative(join(root, 'hooks'), target);
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('hook target escaped package');
    const env = { ...process.env, LOOP_RUNTIME: 'codex', CLAUDE_PLUGIN_ROOT: root };
    env.CLAUDE_PROJECT_DIR = typeof payload.cwd === 'string' ? payload.cwd : process.cwd();
    if (typeof payload.session_id === 'string') env.CLAUDE_CODE_SESSION_ID = payload.session_id;
    if (env.PLUGIN_DATA) env.CLAUDE_PLUGIN_DATA = env.PLUGIN_DATA;
    const result = spawnSync(process.execPath, [target, ...process.argv.slice(3)], {
      input: JSON.stringify(payload), env, cwd: env.CLAUDE_PROJECT_DIR, encoding: 'utf8',
      timeout: 25000, maxBuffer: 8 * 1024 * 1024,
    });
    if (result.error || result.signal) throw new Error('hook process failed or timed out');
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.status !== 0) {
      if (event === 'PreToolUse') throw new Error(`hook exited ${result.status}`);
      process.exitCode = result.status; if (result.stdout) process.stdout.write(result.stdout);
    }
    else {
      const output = adaptOutput(event, result.stdout || '');
      if (output) process.stdout.write(output);
      // Only the heartbeat emits the package warning, once per engine SessionStart.
      if (event === 'SessionStart' && relTarget.endsWith('/loop-doctor-heartbeat.mjs')) {
        process.stdout.write('\n[paul-loop Codex adapter] This hook fired; installation alone never proves all hooks are trusted. Native Workflow JS and PermissionDenied/InstructionsLoaded/PostToolUseFailure telemetry are unsupported. Hook ask remains deny on identical retries; separate review alone does not change it. A supported human-authorized host route is required. See runtime/capabilities.json.\n');
      }
    }
  } catch (error) { eventFailure(event, `[paul-loop codex] ${error.message}; no approval was granted.`); }
}
