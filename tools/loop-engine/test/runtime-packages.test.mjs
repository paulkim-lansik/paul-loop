import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { buildPackages, writePackages } from '../../../scripts/generate-runtime-packages.mjs';
import { adaptOutput } from '../runtime/hook-adapter.mjs';
import { embedRoleResources, localMarkdownLinks, rebaseDocLinks, validateGeneratedDocRefs } from '../../../scripts/runtime-docs.mjs';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const json = (p) => JSON.parse(readFileSync(p, 'utf8'));
const source = (p) => readFileSync(join(root, p), 'utf8');
const write = (p, body) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, body); };
const temp = (t) => { const p = realpathSync(mkdtempSync(join(tmpdir(), 'runtime 한글 '))); t.after(() => rmSync(p, { recursive: true, force: true })); return p; };
const clean = { PATH: process.env.PATH };
const run = (file, args = [], options = {}) => spawnSync(process.execPath, [file, ...args], { encoding: 'utf8', env: clean, timeout: 30000, ...options });

test('external trust paths trigger the unchanged pinned runner from base CODEOWNERS', (t) => {
  const owners = source('CODEOWNERS');
  const entries = owners.split('\n').filter(line => line.startsWith('/')).map(line => line.trim().split(/\s+/));
  const covers = path => entries.some(([prefix, owner]) => owner === '@paulkim-lansik' && (prefix.endsWith('/') ? ('/' + path).startsWith(prefix) : '/' + path === prefix));
  for (const path of ['tools/loop-engine/runtime/new-adapter.mjs', 'tools/loop-engine/eval/new-grader.mjs',
    'scripts/generate-runtime-packages.mjs', 'scripts/runtime-docs.mjs', 'scripts/refresh-skill-lock.mjs',
    'tools/ship-flow/workflows/harness-audit.js', 'tools/ship-flow/templates/branch-protect.sh',
    'tools/ship-flow/templates/branch-protect.mjs', 'tools/ship-flow/templates/setup-loop-engine.action.yml.template',
    ...['provenance.ts', 'store.ts', 'lessons.ts', 'knowledge.ts', 'ops.ts', 'cli.ts', 'schema/memory.ts'].map(p => 'tools/loop-memory/src/' + p),
    'tools/loop-memory/hooks/graduate-lessons.mjs', 'tools/loop-memory/dist/cli.js', 'tools/loop-memory/test/hardening.test.ts']) assert.ok(covers(path), path);
  // Actual base-test execution, not a second copy of the runner's prefix matcher.
  for (const path of ['scripts/runtime-docs.mjs', 'tools/ship-flow/workflows/harness-audit.js',
    'tools/ship-flow/templates/branch-protect.mjs', 'tools/loop-memory/src/provenance.ts']) {
    const dir = temp(t);
    const git = args => execFileSync('git', ['-C', dir, ...args], { env: { ...clean, HOME: dir }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git(['init', '-qb', 'main']);
    write(join(dir, 'CODEOWNERS'), owners);
    write(join(dir, path), 'trusted\n');
    write(join(dir, 'tools/loop-engine/test/run.sh'), 'set -eu\nbash tools/loop-engine/test/trust.test.sh\n');
    write(join(dir, 'tools/loop-engine/test/trust.test.sh'), `set -eu\n[ "$(cat '${path}')" = trusted ]\n`);
    const commit = message => { git(['add', '.']); git(['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', message]); };
    commit('base'); const base = git(['rev-parse', 'HEAD']);
    write(join(dir, path), 'weakened\n'); commit('change only external trust implementation');
    const result = spawnSync('bash', [join(root, 'tools/loop-engine/bin/verifier-pinned-review.sh'), '--base', base, '--repo-root', dir], { encoding: 'utf8', env: { ...clean, HOME: dir }, timeout: 30000 });
    assert.equal(result.status, 1, `${path}: ${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /base .* suite broke against this PR/);
    assert.doesNotMatch(result.stdout, /skipping pinned-baseline check/);
  }
});

test('both generated runtimes are deterministic, internally versioned and packaged without installed caches', (t) => {
  const dir = temp(t), files = buildPackages(root), again = buildPackages(root);
  assert.deepEqual(files, again);
  writePackages(files, join(dir, 'one')); writePackages(again, join(dir, 'two'));
  writePackages(files, join(dir, 'one'), true);
  const provenance = json(join(dir, 'one/provenance.json'));
  assert.equal(provenance.sourceVersions['loop-engine'], '0.15.0');
  assert.ok(provenance.sourceHashes['skills-lock.json']);
  assert.equal(provenance.limitations.liveEndToEnd, 'not-verified');
  for (const runtime of ['claude', 'codex']) {
    for (const [name, version] of Object.entries(provenance.sourceVersions)) {
      const plugin = join(dir, 'one', runtime, 'plugins', name);
      const manifest = json(join(plugin, `.${runtime}-plugin/plugin.json`));
      assert.equal(manifest.name, name); assert.equal(manifest.version, version);
      if (runtime === 'codex') assert.equal(existsSync(join(plugin, '.claude-plugin/plugin.json')), false);
    }
  }
  const catalog = json(join(dir, 'one/codex/.agents/plugins/marketplace.json'));
  assert.equal(catalog.name, 'paul-loop-codex');
  assert.equal(catalog.plugins.length, 3);
  for (const plugin of catalog.plugins) {
    assert.ok(existsSync(join(dir, 'one/codex', plugin.source.path, '.codex-plugin/plugin.json')));
    assert.equal(plugin.policy.installation, 'AVAILABLE'); // never auto-enables optional memory
  }
  const hooks = json(join(dir, 'one/codex/plugins/loop-engine/hooks/hooks.json')).hooks;
  for (const event of ['PermissionDenied', 'InstructionsLoaded', 'PostToolUseFailure']) assert.equal(hooks[event], undefined);
  for (const groups of Object.values(hooks)) for (const group of groups) for (const hook of group.hooks) {
    assert.match(hook.command, /\$\{PLUGIN_ROOT\}\/runtime\/hook-adapter\.mjs/);
    assert.equal(hook.command.includes('CLAUDE_PLUGIN_ROOT'), false);
    const target = / (hooks\/[^ ]+)/.exec(hook.command)[1];
    assert.ok(existsSync(join(dir, 'one/codex/plugins/loop-engine', target)));
  }
  const role = source('tools/ship-flow/agents/code-reviewer.md');
  const skill = readFileSync(join(dir, 'one/codex/plugins/ship-flow/skills/code-reviewer/SKILL.md'), 'utf8');
  assert.match(skill, /fresh subagent/); assert.match(skill, /does not constrain tools/);
  const template = readFileSync(join(dir, 'one/codex/plugins/ship-flow/agent-templates/code-reviewer.toml'), 'utf8');
  assert.match(template, /sandbox_mode = "read-only"/); assert.ok(role.length > 100);
  assert.equal(existsSync(join(dir, 'one/codex/plugins/ship-flow/.codex/agents')), false);
  assert.match(readFileSync(join(dir, 'one/codex/plugins/ship-flow/skills/ship-feature/SKILL.md'), 'utf8'), /Native Claude Workflow JS is unsupported/);
});

test('generated inventory detects missing, altered, extra files and executable mode drift', (t) => {
  const dir = join(temp(t), 'out');
  const files = new Map([['.paul-loop-generated.json', { content: Buffer.from('{}'), mode: 0o644 }], ['bin/probe.mjs', { content: Buffer.from('original'), mode: 0o755 }]]);
  writePackages(files, dir);
  write(join(dir, 'extra'), 'stray'); assert.throws(() => writePackages(files, dir, true), /inventory drift/);
  writePackages(files, dir); write(join(dir, 'bin/probe.mjs'), 'modified'); assert.throws(() => writePackages(files, dir, true), /artifact drift/);
  writePackages(files, dir); chmodSync(join(dir, 'bin/probe.mjs'), 0o644); assert.throws(() => writePackages(files, dir, true), /artifact drift/);
  writePackages(files, dir); rmSync(join(dir, 'bin/probe.mjs')); assert.throws(() => writePackages(files, dir, true), /inventory drift/);
  const other = join(dirname(dir), 'unowned'); mkdirSync(other); write(join(other, 'keep'), 'owned elsewhere');
  assert.throws(() => writePackages(files, other), /unowned/); assert.equal(readFileSync(join(other, 'keep'), 'utf8'), 'owned elsewhere');
  const link = join(dirname(dir), 'alias'); symlinkSync(other, link); assert.throws(() => writePackages(files, link), /symlink/);
  const outside = run(join(root, 'scripts/generate-runtime-packages.mjs'), ['--out', other]);
  assert.notEqual(outside.status, 0); assert.match(outside.stderr, /output must be under/);
});

test('hook adapter maps ask to deny, preserves denies, fails closed on crashes and leaves trust explicit', (t) => {
  const ask = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: 'risky operation' } };
  const adapted = JSON.parse(adaptOutput('PreToolUse', JSON.stringify(ask)));
  assert.equal(adapted.hookSpecificOutput.permissionDecision, 'deny'); assert.match(adapted.hookSpecificOutput.permissionDecisionReason, /Human review required/);
  assert.equal(JSON.parse(adaptOutput('PreToolUse', JSON.stringify(adapted))).hookSpecificOutput.permissionDecision, 'deny');
  const dir = temp(t);
  cpSync(join(root, 'tools/loop-engine/runtime'), join(dir, 'runtime'), { recursive: true });
  write(join(dir, 'hooks/ask.mjs'), `console.log(${JSON.stringify(JSON.stringify(ask))});`);
  write(join(dir, 'hooks/crash.mjs'), 'process.exit(1)');
  write(join(dir, 'hooks/env.mjs'), 'console.log(JSON.stringify({root:process.env.CLAUDE_PLUGIN_ROOT,cwd:process.env.CLAUDE_PROJECT_DIR,session:process.env.CLAUDE_CODE_SESSION_ID}));');
  const invoke = (target, event = 'PreToolUse') => run(join(dir, 'runtime/hook-adapter.mjs'), [target], { cwd: dir, input: JSON.stringify({hook_event_name:event,cwd:dir,session_id:'fixture'}) });
  for (const target of ['hooks/ask.mjs', 'hooks/crash.mjs', 'hooks/missing.mjs', 'hooks/../runtime/capabilities.json']) {
    const res = invoke(target); assert.equal(res.status, 0, res.stderr); assert.equal(JSON.parse(res.stdout).hookSpecificOutput.permissionDecision, 'deny');
  }
  const env = JSON.parse(invoke('hooks/env.mjs', 'SessionStart').stdout);
  assert.deepEqual(env, {root:dir,cwd:dir,session:'fixture'});
  write(join(dir, 'hooks/loop-doctor-heartbeat.mjs'), '');
  assert.match(invoke('hooks/loop-doctor-heartbeat.mjs', 'SessionStart').stdout, /installation alone never proves all hooks are trusted/);
  assert.notEqual(invoke('hooks/env.mjs', 'InstructionsLoaded').status, 0);
  const bad = run(join(dir, 'runtime/hook-adapter.mjs'), ['hooks/ask.mjs'], {input:'invalid'}); assert.equal(bad.status, 2);
});

test('native direct mjs launch no longer returns EACCES, and doctor never attests hook trust', (t) => {
  const dir = temp(t);
  write(join(dir, 'bin/gh'), '#!/bin/sh\nexit 1\n'); chmodSync(join(dir, 'bin/gh'), 0o755);
  const env = {...clean, HOME:dir, CLAUDE_CONFIG_DIR:join(dir,'empty-config'), PATH:join(dir,'bin')+':'+process.env.PATH};
  for (const name of readdirSync(join(root, 'tools/loop-engine/bin')).filter(n => n.endsWith('.mjs'))) {
    assert.equal(lstatSync(join(root, 'tools/loop-engine/bin', name)).mode & 0o111, 0o111, `${name} must be executable`);
  }
  for (const name of ['deps-audit.mjs', 'mattpocock-skills-sync-check.mjs', 'plugin-path.mjs', 'runtime-doctor.mjs', 'agent-eval.mjs', 'evidence.mjs']) {
    const path = join(root, 'tools/loop-engine/bin', name);
    assert.equal(lstatSync(path).mode & 0o111, 0o111, name);
    // Use the real entrypoint with empty HOME and offline gh. The sync checker has no --help.
    const args = name === 'mattpocock-skills-sync-check.mjs' ? ['--stamp'] : ['--help'];
    const res = spawnSync(path, args, {cwd:dir,env,encoding:'utf8',timeout:5000});
    assert.equal(res.error, undefined, `${name}: ${res.error}`); assert.equal(res.signal, null);
    if (name === 'agent-eval.mjs' || name === 'evidence.mjs') {
      assert.equal(res.status, name === 'agent-eval.mjs' ? 2 : 1); assert.match(res.stderr, /Usage:/); // each CLI's usage status; no target/grader or evidence write
    }
  }
  const res = run(join(root, 'tools/loop-engine/bin/runtime-doctor.mjs'), ['--require', 'hooks'], {cwd:dir,env:{...clean,LOOP_RUNTIME:'claude',LOOP_ENGINE_PATH:join(root,'tools/loop-engine')}});
  assert.equal(res.status, 1); const report = JSON.parse(res.stdout);
  assert.equal(report.hookTrust, 'unknown'); assert.equal(report.liveEndToEnd, 'not-verified');
  assert.ok(report.problems.some(p => p.includes('host verification')));
});

test('setup action executes twice with independent temporary dirs, preserves spaces and validates pins', (t) => {
  const dir = temp(t), bin = join(dir, 'bin'), runner = join(dir, 'runner space'); mkdirSync(runner);
  const body = source('tools/ship-flow/templates/setup-loop-engine.action.yml.template').split('      run: |\n')[1].split('\n').map(line => line.slice(8)).join('\n').replaceAll('{{LOOP_ENGINE_TAG}}','v0.15.0').replaceAll('{{SHIP_FLOW_TAG}}','v0.11.0');
  assert.ok(body.includes('git clone'));
  // Stub only the network clone. Execute the actual resolver and action shell against real manifests.
  write(join(bin, 'git'), '#!/usr/bin/env node\n' + `const fs=require('node:fs'),p=require('node:path');const args=process.argv.slice(2);if(args[0]!=='clone')process.exit(1);const dst=args.at(-1),engine=args.includes('loop-engine--v0.15.0'),ship=args.includes('ship-flow--v0.11.0');if(!engine&&!ship)process.exit(4);fs.mkdirSync(dst,{recursive:true});fs.cpSync(p.join(process.env.FIXTURE_SOURCE,'tools',engine?'loop-engine':'ship-flow'),p.join(dst,'tools',engine?'loop-engine':'ship-flow'),{recursive:true,filter:s=>!s.includes('node_modules')});`);
  chmodSync(join(bin, 'git'), 0o755);
  const outputs=[];
  for (let i=0;i<2;i++) {
    const out=join(dir,`env-${i}`); write(out,'');
    const result=spawnSync('/bin/bash',['-c',body],{cwd:dir,encoding:'utf8',env:{...clean,PATH:bin+':'+process.env.PATH,RUNNER_TEMP:runner,GITHUB_ENV:out,FIXTURE_SOURCE:root},timeout:30000});
    assert.equal(result.status,0,result.stderr); const entries=Object.fromEntries(readFileSync(out,'utf8').trim().split('\n').map(l=>l.split('=')));
    assert.equal(entries.LOOP_RUNTIME,'shell'); assert.ok(entries.LOOP_ENGINE_PATH.startsWith(runner+'/paul-loop.')); assert.ok(existsSync(entries.SHIP_FLOW_PATH)); outputs.push(entries.LOOP_ENGINE_PATH);
  }
  assert.notEqual(outputs[0],outputs[1]); assert.ok(existsSync(outputs[0]));
  const failed=join(dir,'failed-env');write(failed,'');
  const res=spawnSync('/bin/bash',['-c',body.replace('ship-flow--v0.11.0','ship-flow--v0.0.0')],{cwd:dir,encoding:'utf8',env:{...clean,PATH:bin+':'+process.env.PATH,RUNNER_TEMP:runner,GITHUB_ENV:failed,FIXTURE_SOURCE:root},timeout:30000});
  assert.notEqual(res.status,0); assert.equal(readFileSync(failed,'utf8'),''); assert.ok(existsSync(outputs[0]));
});

test('release tags depend on validation at the event SHA and CI compares committed runtime bundle', () => {
  const release=source('.github/workflows/tag-on-publish.yml');
  assert.match(release, /needs: \[engine, memory, runtime, secrets-scan\]/);
  for (const workflow of ['loop-engine-test','loop-memory-test','runtime-packages','gitleaks']) {
    assert.ok(release.includes(`uses: ./.github/workflows/${workflow}.yml`));
    assert.match(source(`.github/workflows/${workflow}.yml`), /workflow_call:/);
  }
  assert.match(release,/if: github.ref == 'refs\/heads\/main'/);
  assert.match(release,/SHA: \$\{\{ github.sha \}\}/);
  assert.match(release,/git push origin "\$\{new_refs\[@\]\}"/);
  assert.match(source('.github/workflows/loop-memory-test.yml'), /git diff --exit-code -- dist\/cli\.js/);
});

test('moved role references rebase from agents to skills and generated doc validation rejects regression', () => {
  const input = '[authorization](../skills/AUTHORIZATION.md) and [handoff](../skills/ship-feature/PUBLISH-HANDOFF.md#safe-pattern)';
  const moved = rebaseDocLinks(input, 'agents/publisher.md', 'skills/publisher/SKILL.md');
  assert.equal(moved, '[authorization](../AUTHORIZATION.md) and [handoff](../ship-feature/PUBLISH-HANDOFF.md#safe-pattern)');
  const file = content => ({content:Buffer.from(content),mode:0o644});
  const prefix = 'codex/plugins/ship-flow/';
  const files = new Map([[prefix+'skills/publisher/SKILL.md', file(moved)], [prefix+'skills/AUTHORIZATION.md',file('contract')], [prefix+'skills/ship-feature/PUBLISH-HANDOFF.md',file('handoff')]]);
  assert.equal(validateGeneratedDocRefs(files).references, 2);
  files.set(prefix+'skills/publisher/SKILL.md',file(input));
  assert.throws(() => validateGeneratedDocRefs(files), /dangling generated documentation reference/);
  files.set(prefix+'skills/publisher/SKILL.md',file(moved)); files.delete(prefix+'skills/AUTHORIZATION.md');
  assert.throws(() => validateGeneratedDocRefs(files), /AUTHORIZATION.md/);
  assert.deepEqual(localMarkdownLinks('`[example](missing.md)`\n```md\n[example](missing.md)\n```\n[web](https://example.invalid)\n[anchor](#example)'), []);
});

test('relocated native role templates embed required contracts and keep scratch access conditional', (t) => {
  const files = buildPackages(root), dir = temp(t), prefix = 'codex/plugins/ship-flow/';
  const contract = source('tools/ship-flow/skills/AUTHORIZATION.md').replaceAll('CLAUDE.md','AGENTS.md');
  const handoff = source('tools/ship-flow/skills/ship-feature/PUBLISH-HANDOFF.md').replaceAll('CLAUDE.md','AGENTS.md');
  for (const role of ['planner','code-reviewer','test-hunter','verifier-integrity-hunter','publisher']) {
    const toml = files.get(prefix+`agent-templates/${role}.toml`).content.toString();
    const relocated = join(dir, 'consumer/.codex/agents',role+'.toml'); write(relocated,toml);
    const instructions = JSON.parse(/^developer_instructions = (.*)$/m.exec(readFileSync(relocated,'utf8'))[1]);
    assert.ok(instructions.includes(contract), role+' must carry full shared contract');
    if (role === 'publisher') assert.ok(instructions.includes(handoff));
    assert.deepEqual(localMarkdownLinks(instructions), [], role+' cannot require relative plugin resource files in a consumer');
    assert.match(instructions,/host-permitted temporary directory/); assert.match(instructions,/does not itself guarantee temporary-directory writes/);
    assert.match(instructions,/continue independent authorized checks/);
    assert.match(toml,role==='publisher'?/sandbox_mode = "workspace-write"/:/sandbox_mode = "read-only"/);
    const skill = files.get(prefix+`skills/${role}/SKILL.md`).content.toString();
    assert.ok(localMarkdownLinks(skill).some(link=>link.target==='../AUTHORIZATION.md'));
  }
  // Embedded dependency closure is portable even when a required resource links to another one.
  const embedded=embedRoleResources('[auth](../skills/AUTH.md)','agents/reviewer.md',p=>({'skills/AUTH.md':'[detail](detail.md)','skills/detail.md':'keep the gate'})[p]);
  assert.deepEqual(localMarkdownLinks(embedded), []); assert.match(embedded,/keep the gate/);
  assert.throws(()=>embedRoleResources('[auth](../skills/missing.md)','agents/reviewer.md',()=>undefined),/resource missing/);
});

test('Codex harness audit retains its authorized direct-lane fallback without blanket task stopping', () => {
  const files=buildPackages(root), text=files.get('codex/plugins/ship-flow/skills/harness-maturity-audit/SKILL.md').content.toString();
  assert.match(text,/skill-documented direct-lane or equivalent fallback/);
  assert.match(text,/preserves required independence, gates and current authorization/);
  assert.match(text,/report that blocked step and continue independent authorized work/);
  assert.match(text,/perform the\s+same bounded lanes directly/);
  assert.match(text,/recording which checks could not be performed/);
  assert.doesNotMatch(text,/unsupported; stop and report the missing capability when a step requires Workflow/);
});

test('actual PreToolUse subprocess invalid stdout cannot be laundered into defer or approval', (t) => {
  const dir=temp(t); cpSync(join(root,'tools/loop-engine/runtime'),join(dir,'runtime'),{recursive:true});
  const invoke=output=>{
    write(join(dir,'hooks/output.mjs'),`process.stdout.write(${JSON.stringify(output)});`);
    return run(join(dir,'runtime/hook-adapter.mjs'),['hooks/output.mjs'],{cwd:dir,input:JSON.stringify({hook_event_name:'PreToolUse',cwd:dir})});
  };
  const specific = decision => JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:decision}});
  for (const output of ['not json','{}','null','[]','"allow"','{',specific('approved'),JSON.stringify({hookSpecificOutput:{hookEventName:'Stop',permissionDecision:'allow'}}),JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'allow',permissionDecisionReason:{}}}),JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'allow',updatedInput:[]}}),JSON.stringify({decision:'allow'}),specific('allow')+'\ntrailing',JSON.stringify({extra:true,hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'allow'}})]) {
    const result=invoke(output); assert.equal(result.status,0,result.stderr);
    const value=JSON.parse(result.stdout).hookSpecificOutput;
    assert.equal(value.permissionDecision,'deny'); assert.match(value.permissionDecisionReason,/Invalid PreToolUse hook output/);
  }
  for (const output of ['', ' \n']) {const result=invoke(output);assert.equal(result.status,0);assert.equal(result.stdout,'');}
  for (const decision of ['allow','deny']) assert.equal(JSON.parse(invoke(specific(decision)).stdout).hookSpecificOutput.permissionDecision,decision);
  const valid={hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'allow',permissionDecisionReason:'fixture',updatedInput:{command:'echo ok'},additionalContext:'context'},suppressOutput:true};
  assert.deepEqual(JSON.parse(invoke(JSON.stringify(valid)).stdout),valid);
  for (let attempt=0;attempt<2;attempt++) {
    const value=JSON.parse(invoke(specific('ask')).stdout).hookSpecificOutput;
    assert.equal(value.permissionDecision,'deny');assert.match(value.permissionDecisionReason,/identical retry/);assert.match(value.permissionDecisionReason,/adapter records no approval/);
  }
  assert.equal(adaptOutput('SessionStart','plain context'),'plain context');
});
