#!/usr/bin/env node
// Pure deterministic conversion, followed by an explicit output-directory write.
// Never reads or modifies installed plugin caches, host settings, or credentials.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { embedRoleResources, rebaseDocLinks, scratchContract, validateGeneratedDocRefs } from './runtime-docs.mjs';

const adapterVersion = '1.0.0';
const json = (value) => JSON.stringify(value, null, 2) + '\n';
const sha = (value) => createHash('sha256').update(value).digest('hex');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const supportedEvents = new Set(['SessionStart', 'SessionEnd', 'PermissionRequest', 'SubagentStart', 'SubagentStop', 'PreCompact', 'Stop', 'PreToolUse', 'UserPromptSubmit']);

export function buildPackages(root) {
  const files = new Map();
  const put = (path, content, mode = 0o644) => files.set(path, { content: Buffer.from(content), mode });
  const sourceFiles = execFileSync('git', ['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', 'tools'], { encoding: 'utf8' }).split('\0').filter(Boolean).sort();
  const sourceCatalog = readJson(join(root, '.claude-plugin/marketplace.json'));
  const capabilities = readJson(join(root, 'tools/loop-engine/runtime/capabilities.json'));
  const versions = Object.fromEntries(sourceCatalog.plugins.map((p) => [p.name, readJson(join(root, p.source, '.claude-plugin/plugin.json')).version]));
  const provenance = { schemaVersion: 1, adapterVersion, sourceCommit: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), sourceVersions: versions, sourceHashes: Object.fromEntries(['scripts/generate-runtime-packages.mjs', 'scripts/runtime-docs.mjs', '.claude-plugin/marketplace.json', 'skills-lock.json', 'docs/runtime-compatibility.md', 'LICENSE', 'NOTICE'].map((p) => [p, { sha256: sha(readFileSync(join(root, p))) }])), limitations: capabilities.codex };
  for (const runtime of ['claude', 'codex']) {
    const catalog = [];
    for (const plugin of sourceCatalog.plugins) {
      if (!/^\.\/tools\/[a-z][a-z0-9-]*$/.test(plugin.source)) throw new Error('unsupported plugin source path');
      if (!/^[a-z][a-z0-9-]*$/.test(plugin.name)) throw new Error('invalid plugin name');
      const prefix = plugin.source.slice(2) + '/';
      const out = `${runtime}/plugins/${plugin.name}`;
      const manifest = readJson(join(root, prefix, '.claude-plugin/plugin.json'));
      for (const legal of ['LICENSE', 'NOTICE']) put(`${out}/${legal}`, readFileSync(join(root, legal)));
      put(`${out}/runtime/README.md`, readFileSync(join(root, 'docs/runtime-compatibility.md')));
      if (manifest.name !== plugin.name) throw new Error('marketplace plugin name drift');
      if (plugin.version !== manifest.version) throw new Error(`marketplace version drift: ${plugin.name}`);
      for (const dep of manifest.dependencies || []) {
        if (dep.name === 'loop-engine' && dep.version !== `^${versions['loop-engine'].split('.').slice(0, 2).join('.')}.0`) throw new Error('engine dependency range drift');
      }
      for (const source of sourceFiles.filter((p) => p.startsWith(prefix))) {
        let rel = source.slice(prefix.length);
        if (rel.split('/').some((p) => p === 'node_modules' || p === '.loop' || p.startsWith('.env'))) continue;
        const absolute = join(root, source);
        if (!existsSync(absolute)) continue; // concurrent deletion will be caught by final source hashes/check
        const stat = lstatSync(absolute);
        if (!stat.isFile()) throw new Error(`non-file source rejected: ${source}`);
        const bytes = readFileSync(absolute);
        provenance.sourceHashes[source] = { sha256: sha(bytes), mode: stat.mode & 0o777 };
        if (runtime === 'codex' && (rel.startsWith('.claude-plugin/') || rel === 'hooks/hooks.json')) continue;
        let content = bytes;
        if (runtime === 'codex' && /\.md(?:\.template)?$/.test(rel)) {
          const rootRef = '${' + { 'loop-engine': 'LOOP_ENGINE_PATH', 'ship-flow': 'SHIP_FLOW_PATH', 'loop-memory': 'LOOP_MEMORY_PATH' }[plugin.name] + '}';
          content = bytes.toString('utf8').replaceAll('CLAUDE.md', 'AGENTS.md')
            .replaceAll('${CLAUDE_PLUGIN_ROOT}', rootRef)
            .replaceAll('AskUserQuestion', 'the active host user-input mechanism');
          if (rel.endsWith('/SKILL.md')) {
            // Capability flags stay in a visible contract instead of masquerading as native agent options.
            content = content.replace(/^---\n([\s\S]*?)\n---/, (_, frontmatter) => {
              const shared = frontmatter.split('\n').filter((line) => !/^(context|allowed-tools|disable-model-invocation|agent|model|tools):/.test(line));
              return `---\n${shared.join('\n')}\ncompatibility: Requires the generated paul-loop Codex runtime and explicit hook trust; see runtime/capabilities.json.\n---`;
            });
            const marker = content.indexOf('\n---', 4) + 4;
            const contract = '\n\n> Codex runtime contract: first resolve this plugin root from the absolute skill-file location and set its LOOP_ENGINE_PATH, SHIP_FLOW_PATH or LOOP_MEMORY_PATH input for shell examples; set LOOP_RUNTIME=codex. Use loop-engine through an explicit pluginBinPrefix; no automatic bin PATH is assumed. Keep the shared .claude/ship-flow.config.json compatibility file. Human approval requirements remain in force. Run delegated review roles in fresh subagents; a skill alone grants no isolation or restricted tools. Native Claude Workflow JS is unsupported in this adapter. Use a skill-documented direct-lane or equivalent fallback when it preserves required independence, gates and current authorization. If a required capability has no valid fallback, report that blocked step and continue independent authorized work; never claim independent review or completed coverage from a direct pass.\n';
            content = content.slice(0, marker) + contract + content.slice(marker);
          }
          rel = rel.replaceAll('CLAUDE.md', 'AGENTS.md');
        }
        put(`${out}/${rel}`, content, stat.mode & 0o777);
      }
      if (runtime === 'codex') {
        const nativeHooks = existsSync(join(root, prefix, 'hooks/hooks.json')) ? readJson(join(root, prefix, 'hooks/hooks.json')).hooks : {};
        const hooks = {};
        for (const [event, groups] of Object.entries(nativeHooks)) {
          if (!supportedEvents.has(event)) continue;
          hooks[event] = groups.map((group) => ({ ...group, hooks: group.hooks.map((hook) => {
            const match = /^node "\$\{CLAUDE_PLUGIN_ROOT\}\/(hooks\/[a-z0-9-]+\.mjs)"(.*)$/.exec(hook.command);
            if (!match || hook.type !== 'command') throw new Error(`unmapped hook command: ${plugin.name}/${event}`);
            return { ...hook, command: `node "\${PLUGIN_ROOT}/runtime/hook-adapter.mjs" ${match[1]}${match[2]}` };
          }) }));
        }
        if (Object.keys(hooks).length) put(`${out}/hooks/hooks.json`, json({ hooks }));
        // Copy shared adapters into each self-contained plugin; no ../ sibling imports at runtime.
        for (const rel of ['capabilities.json', 'hook-adapter.mjs']) put(`${out}/runtime/${rel}`, readFileSync(join(root, 'tools/loop-engine/runtime', rel)));
        const roles = sourceFiles.filter((p) => p.startsWith(prefix + 'agents/') && p.endsWith('.md'));
        for (const source of roles) {
          const original = readFileSync(join(root, source), 'utf8');
          const name = /^name: (.+)$/m.exec(original)?.[1];
          const description = /^description: (.+)$/m.exec(original)?.[1];
          if (!name || !description) throw new Error('agent role missing metadata');
          const rolePath = source.slice(prefix.length);
          const instructions = files.get(`${out}/${rolePath}`).content.toString('utf8').replace(/^---\n[\s\S]*?\n---\n/, '');
          const skillPath = `skills/${name}/SKILL.md`;
          const roleIntro = 'Run this role in a fresh subagent using the reviewed project-agent template. If required isolation is unavailable, report that role as blocked to the caller; independent authorized preparation can continue. The SKILL.md itself does not constrain tools. Preserve all explicit approval boundaries.';
          put(`${out}/${skillPath}`, `---\nname: ${name}\ndescription: ${description.replaceAll('CLAUDE.md', 'AGENTS.md')}\n---\n\n${roleIntro}\n\n${scratchContract}\n\n${rebaseDocLinks(instructions, rolePath, skillPath)}`);
          // TOML templates are self-contained even after moving to a consumer's .codex/agents.
          // Keep review source read-only; temporary fixture access is a separate host capability.
          const sandbox = name === 'publisher' ? 'workspace-write' : 'read-only';
          const required = ['skills/AUTHORIZATION.md', ...(name === 'publisher' ? ['skills/ship-feature/PUBLISH-HANDOFF.md'] : [])];
          const embedded = embedRoleResources(`${roleIntro}\n\n${instructions}`, rolePath,
            path => files.get(`${out}/${path}`)?.content.toString('utf8'), required);
          put(`${out}/agent-templates/${name}.toml`, `name = ${JSON.stringify(name)}\ndescription = ${JSON.stringify(description)}\nsandbox_mode = ${JSON.stringify(sandbox)}\ndeveloper_instructions = ${JSON.stringify(embedded)}\n`);
        }
        put(`${out}/.codex-plugin/plugin.json`, json({ name: manifest.name, version: manifest.version, description: manifest.description,
          author: manifest.author, homepage: manifest.homepage, repository: manifest.repository, license: manifest.license,
          ...(plugin.name === 'ship-flow' ? { skills: './skills/' } : {}),
          interface: { displayName: plugin.name, shortDescription: `${plugin.name} — generated Codex adapter`, longDescription: manifest.description, developerName: manifest.author.name, category: 'Productivity', defaultPrompt: ['Inspect runtime capabilities and approval boundaries before using this plugin.'], capabilities: plugin.name === 'ship-flow' ? ['Skills'] : ['Hooks'] } }));
        put(`${out}/runtime/dependencies.json`, json({ schemaVersion: 1, dependencies: manifest.dependencies || [], defaultEnabled: manifest.defaultEnabled !== false }));
        catalog.push({ name: plugin.name, source: { source: 'local', path: `./plugins/${plugin.name}` }, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Productivity' });
      } else catalog.push({ ...plugin, source: `./plugins/${plugin.name}` });
    }
    put(runtime === 'codex' ? `${runtime}/.agents/plugins/marketplace.json` : `${runtime}/.claude-plugin/marketplace.json`, json(runtime === 'codex' ? { name: 'paul-loop-codex', interface: { displayName: 'Paul Loop Codex (generated)' }, plugins: catalog } : { ...sourceCatalog, plugins: catalog }));
    put(`${runtime}/plugins.example.json`, json({ schemaVersion: 1, runtime, plugins: Object.fromEntries(Object.entries(versions).map(([name, version]) => [name, { path: `./plugins/${name}`, version }])) }));
  }
  provenance.documentation = validateGeneratedDocRefs(files);
  put('provenance.json', json(provenance));
  const inventory = Object.fromEntries([...files].sort(([a], [b]) => a.localeCompare(b, 'en')).map(([p, { content, mode }]) => [p, { sha256: sha(content), mode }]));
  put('.paul-loop-generated.json', json({ schemaVersion: 1, adapterVersion, files: inventory }));
  return files;
}

export function writePackages(files, out, check = false) {
  for (const rel of files.keys()) {
    if (rel.startsWith('/') || rel.split(/[\\/]/).some(part => part === '..' || part === '')) throw new Error('generated path escapes output');
  }
  if (existsSync(out) && lstatSync(out).isSymbolicLink()) throw new Error('refusing symlink output');
  if (check) {
    const actual = [];
    const walk = (dir) => { for (const ent of readdirSync(dir, { withFileTypes: true })) { const path = join(dir, ent.name); if (ent.isDirectory()) walk(path); else actual.push(relative(out, path).split(sep).join('/')); } };
    walk(out);
    if (actual.length !== files.size || actual.some((p) => !files.has(p))) throw new Error('generated file inventory drift');
    for (const [rel, data] of files) if (!lstatSync(join(out, rel)).isFile() || !readFileSync(join(out, rel)).equals(data.content) || (lstatSync(join(out, rel)).mode & 0o777) !== data.mode) throw new Error(`generated artifact drift: ${rel}`);
    return;
  }
  if (existsSync(out)) {
    if (!existsSync(join(out, '.paul-loop-generated.json'))) throw new Error('refusing to overwrite an unowned output directory');
    rmSync(out, { recursive: true });
  }
  for (const [rel, { content, mode }] of files) { const path = join(out, rel); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); chmodSync(path, mode); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const index = process.argv.indexOf('--out');
  const out = resolve(index === -1 ? join(root, 'build/runtime-packages') : process.argv[index + 1] || '');
  // CLI output stays in this checkout's build/; tests use the pure functions with temp directories.
  if (!out.startsWith(join(root, 'build') + sep)) throw new Error('output must be under this checkout build/; installed caches are never output targets');
  let ancestor = out;
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  const physical = realpathSync(ancestor);
  if (physical !== ancestor && !physical.startsWith(realpathSync(root) + sep + 'build' + sep)) throw new Error('output ancestor escapes checkout through a symlink');
  writePackages(buildPackages(root), out, process.argv.includes('--check'));
  console.log(`${process.argv.includes('--check') ? 'Verified' : 'Generated'} runtime packages: ${out}`);
}
