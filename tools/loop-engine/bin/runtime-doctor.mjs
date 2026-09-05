#!/usr/bin/env node
// Read-only capability report. Never reads credentials or silently infers host trust.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { resolvePluginInstallation } from './plugin-path.mjs';
const runtime = process.env.LOOP_RUNTIME || 'claude';
const capabilities = JSON.parse(readFileSync(fileURLToPath(new URL('../runtime/capabilities.json', import.meta.url)), 'utf8'));
const problems = [];
if (!capabilities[runtime]) problems.push(`unsupported runtime: ${runtime}`);
if (Number(process.versions.node.split('.')[0]) < 22) problems.push('Node >=22 required');
if (!capabilities.requirements.platforms.includes(process.platform)) problems.push('Native Windows unsupported; use a Linux/WSL environment');
for (const name of capabilities.requirements.commands) {
  const result = spawnSync('sh', ['-c', 'command -v "$1"', 'paul-loop-doctor', name], { encoding: 'utf8' });
  if (result.status !== 0) problems.push(`missing required command: ${name}`);
}
let installation = null;
try { installation = resolvePluginInstallation({ runtime }); }
catch (error) { problems.push(error.message); }
if (!installation) problems.push('engine artifact unresolved; configure LOOP_ENGINE_PATH or PAUL_LOOP_INSTALLATIONS');
const required = process.argv.indexOf('--require');
if (required !== -1) {
  const name = process.argv[required + 1];
  const status = capabilities[runtime]?.[name];
  if (!status || /unsupported|caller-owned|reference-only|not-attested/.test(status)) problems.push(`required capability unavailable: ${name}`);
  if (name === 'hooks' || name === 'roles' || name === 'workflows') problems.push(`${name} activation/trust/isolation requires host verification; static inspection cannot attest it`);
}
console.log(JSON.stringify({ schemaVersion: 1, runtime, artifact: installation, capabilities: capabilities[runtime] || null,
  hostActivation: 'unknown', hookTrust: 'unknown', liveEndToEnd: 'not-verified', problems }, null, 2));
process.exitCode = problems.length ? 1 : 0;
