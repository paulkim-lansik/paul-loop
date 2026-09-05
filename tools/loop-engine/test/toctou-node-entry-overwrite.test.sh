#!/usr/bin/env bash
# Freeze delegated Node entries, not only their thin .test.sh launchers. Exercise the actual
# candidate runner in standalone fixtures; leave the existing HEAD-bound shell TOCTOU test intact.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
node --input-type=module - "$HERE/run.sh" <<'JS'
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync, rmSync, symlinkSync, lstatSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
// As in the original regression, pinned review must exercise HEAD's candidate implementation,
// not the old runner temporarily restored from base. During this feature's edit-only introduction
// HEAD predates the guard: exercise the live candidate until its first commit instead.
const head = spawnSync('git', ['-C', dirname(process.argv[2]), 'show', 'HEAD:tools/loop-engine/test/run.sh'], { encoding: 'utf8' });
const runner = head.status === 0 && head.stdout.includes('# TOCTOU_NODE_ENTRY_SNAPSHOT_V1')
  ? head.stdout : readFileSync(process.argv[2], 'utf8');
const root = realpathSync(mkdtempSync(join(tmpdir(), 'node-entry-toctou-')));
const quote = (s) => "'" + s.replaceAll("'", "'\\''") + "'";
function fixture(name) {
  const dir = join(root, name); mkdirSync(dir);
  writeFileSync(join(dir, 'run.sh'), runner);
  return dir;
}
function run(dir) {
  const result = spawnSync('/bin/bash', [join(dir, 'run.sh')], { cwd: dir, encoding: 'utf8', timeout: 15000 });
  assert.ifError(result.error);
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1, output);
  assert.match(output, /^loop-engine selftest: 1\/2 passed$/m);
  return output;
}
try {
  // run.sh remains self-contained: no sibling loader/helper copied into a shell-only fixture.
  const shell = fixture('shell only');
  writeFileSync(join(shell, 'aaa-sabotage.test.sh'), `printf 'echo SHELL_POISON; exit 0\\n' > ${quote(join(shell, 'zzz-victim.test.sh'))}\n`);
  writeFileSync(join(shell, 'zzz-victim.test.sh'), 'echo SHELL_ORIGINAL_FAILURE; exit 1\n');
  const shellOut = run(shell); assert.match(shellOut, /SHELL_ORIGINAL_FAILURE/); assert.doesNotMatch(shellOut, /SHELL_POISON/);

  for (const mode of ['test', 'plain']) for (const mutation of ['overwrite', 'symlink-mjs', 'symlink-cjs']) {
    const dir = fixture(`한글 spaced ${mode} ${mutation}`), entry = join(dir, 'zzz-victim.test.mjs');
    mkdirSync(join(dir, 'helpers'));
    writeFileSync(join(dir, 'helpers/identity.mjs'), 'export const identity = "relative-import-ok";\n');
    const body = `
      import assert from 'node:assert/strict';
      import { pathToFileURL } from 'node:url';
      import { identity } from './helpers/identity.mjs';
      assert.equal(identity, 'relative-import-ok');
      assert.equal(import.meta.url, pathToFileURL(process.argv[1]).href);
      assert.equal(process.argv[1], ${JSON.stringify(entry)});
      console.log('MJS_ORIGINAL_IDENTITY_OK');
    `;
    writeFileSync(entry, body + (mode === 'test'
      ? `import test from 'node:test'; test('MJS_ORIGINAL_FAILURE', () => assert.fail('original test must still fail'));\n`
      : `assert.equal(process.argv[2], 'original-argument'); console.log('MJS_ORIGINAL_FAILURE'); process.exitCode = 1;\n`));
    writeFileSync(join(dir, 'zzz-victim.test.sh'), `node ${mode === 'test' ? '--test ' : ''}${quote(entry)}${mode === 'plain' ? ' original-argument' : ''}\n`);
    // Parent has already captured both files. Poison BOTH the launcher and its delegated body.
    // Unsetting this sibling's NODE_OPTIONS cannot erase the next sibling's parent-held snapshot.
    const poison = join(dir, mutation.endsWith('cjs') ? 'created-after-capture.cjs' : 'created-after-capture.mjs');
    const sabotage = mutation === 'overwrite'
      ? `printf 'console.log("MJS_POISON_EXECUTED");\\n' > ${quote(entry)}`
      : `printf 'console.log("MJS_POISON_EXECUTED");\\n' > ${quote(poison)}\nrm ${quote(entry)}\nln -s ${quote(poison)} ${quote(entry)}`;
    writeFileSync(join(dir, 'aaa-sabotage.test.sh'), `
      unset NODE_OPTIONS
      ${sabotage}
      printf 'echo WRAPPER_POISON_EXECUTED; exit 0\\n' > ${quote(join(dir, 'zzz-victim.test.sh'))}
      echo 'sabotage placed'
    `);
    const output = run(dir);
    assert.match(output, /MJS_ORIGINAL_IDENTITY_OK/);
    assert.match(output, /MJS_ORIGINAL_FAILURE/);
    assert.doesNotMatch(output, /MJS_POISON_EXECUTED|WRAPPER_POISON_EXECUTED/);
    assert.match(readFileSync(entry, 'utf8'), /MJS_POISON_EXECUTED/, 'prove the disk source really was overwritten');
    assert.equal(lstatSync(entry).isSymbolicLink(), mutation !== 'overwrite', 'postcapture symlink replacement really occurred');
  }

  // An entry that WAS an alias at capture retains Node's normal original canonical module URL,
  // its own relative imports, and the caller's alias argv even after that alias is replaced.
  for (const mode of ['test', 'plain']) {
    const dir = fixture(`original alias ${mode}`), entry = join(dir, 'zzz-alias.test.mjs');
    mkdirSync(join(dir, 'original'));
    const actual = join(dir, 'original/body.mjs'), poison = join(dir, 'created-after-capture.mjs');
    writeFileSync(join(dir, 'original/helper.mjs'), 'export const value = "original-relative-import";');
    writeFileSync(actual, `import assert from 'node:assert/strict'; import { pathToFileURL } from 'node:url'; import { value } from './helper.mjs';
      assert.equal(value, 'original-relative-import'); assert.equal(import.meta.url, pathToFileURL(${JSON.stringify(actual)}).href);
      assert.equal(process.argv[1], ${JSON.stringify(entry)}); console.log('ALIAS_ORIGINAL_FAILURE'); process.exitCode = 1;`);
    symlinkSync(actual, entry);
    writeFileSync(join(dir, 'zzz-alias.test.sh'), `node ${mode === 'test' ? '--test ' : ''}${quote(entry)}\n`);
    writeFileSync(join(dir, 'aaa-sabotage.test.sh'), `printf 'console.log("ALIAS_POISON");\\n' > ${quote(poison)}\nrm ${quote(entry)}\nln -s ${quote(poison)} ${quote(entry)}\n`);
    const output = run(dir); assert.match(output, /ALIAS_ORIGINAL_FAILURE/); assert.doesNotMatch(output, /ALIAS_POISON/);
    assert.equal(realpathSync(entry), poison);
  }

  // Capture errors must abort BEFORE an earlier sibling can run, never fall back to live reads.
  const bad = fixture('unreadable entry');
  symlinkSync('missing-target', join(bad, 'zzz-broken.test.mjs'));
  writeFileSync(join(bad, 'aaa-first.test.sh'), 'echo SHOULD_NOT_START\n');
  const result = spawnSync('/bin/bash', [join(bad, 'run.sh')], { cwd: bad, encoding: 'utf8', timeout: 15000 });
  assert.ifError(result.error); assert.equal(result.status, 2);
  assert.doesNotMatch(result.stdout, /SHOULD_NOT_START/);
  console.log('PASS: standalone shell and Node/plain --test snapshots survive sibling overwrites and symlink redirection, preserve original URL/argv/imports, and fail closed on capture errors');
} finally { rmSync(root, { recursive: true, force: true }); }
JS
