// Test-only receipt issuer for behavioral unit fixtures. Production CLI has no bypass.
// End-to-end receipt issuance is tested separately through verdict-run.
import { mkdirSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { sanitizeText } from '../../lib/sanitize.mjs';
import { writeEvidence } from '../../lib/evidence-graph.mjs';
const [bin, ...args] = process.argv.slice(2);
const value = flag => args[args.lastIndexOf(flag) + 1];
const dir = resolve(value('--lessons'));
mkdirSync(dir, { recursive: true });
const root = realpathSync(dir);
const hash = v => createHash('sha256').update(v).digest('hex');
if (args.includes('--verified') || args[0] === 'mark-clean') {
  const run = randomUUID();
  const now = Date.now(), time = n => new Date(now + n).toISOString();
  const evidenceDir = join(root, '.loop', 'evidence');
  const base = { kind: 'verification', mode: 'gate', run_id: run,
    root_hash: hash(root), command_hash: hash(JSON.stringify(['sh', '-c', args.includes('--gate') ? value('--gate') : 'fixture verify'])),
    target_before: { sha: 'fixture', digest: hash('stable'), dirty: false },
    target_after: { sha: 'fixture', digest: hash('stable'), dirty: false } };
  if (args.includes('--verified')) {
    const i = args.indexOf('--signature-file');
    if (i !== -1) {
      const bytes = Buffer.from(sanitizeText(readFileSync(args[i+1], 'utf8'))); // real verifier output is sanitized too
      const snapshot = join(root, `.loop/failure-${run}.txt`);
      mkdirSync(join(root, '.loop'), { recursive: true }); writeFileSync(snapshot, bytes); args[i+1] = snapshot;
      const fail = writeEvidence(evidenceDir, { ...base, verdict: 'FAIL', exit: 1,
        target_before: { digest: hash('broken implementation') }, target_after: { digest: hash('broken implementation') },
        verdict_sha256: hash(bytes), started_at: time(-4), finished_at: time(-3) });
      args.push('--failure-receipt', join(evidenceDir, `${fail.id}.json`));
    }
  }
  const pass = writeEvidence(evidenceDir, { ...base, verdict: 'PASS', exit: 0,
    verdict_sha256: hash('VERDICT: PASS\n'), started_at: time(-2), finished_at: time(-1) });
  args.push('--receipt', join(evidenceDir, `${pass.id}.json`));
}
// Keep test artifacts in the fixture directory; never emit receipts in the source checkout.
args[args.lastIndexOf('--lessons') + 1] = dir;
const result = spawnSync(process.execPath, [resolve(bin), ...args], { cwd: root, env: { ...process.env, LOOP_DIR: '.loop' }, stdio: 'inherit' });
process.exit(result.status ?? 1);
