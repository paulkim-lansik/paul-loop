import { readFileSync, renameSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { observedIdentity, workspaceIdentity, sha256 } from './workspace-identity.mjs'
import { evidenceDir, writeEvidence } from './evidence-graph.mjs'
import { parseVerdict } from './verdict-contract.mjs'
import { sanitizeText } from './sanitize.mjs'

const [op, ...args] = process.argv.slice(2)
try {
  if (op === 'start') {
    const [log, ...command] = args
    process.stdout.write(JSON.stringify({ target: observedIdentity({ log }), started_at: new Date().toISOString(), command_hash: sha256(JSON.stringify(command)) }))
  } else if (op === 'digest') {
    process.stdout.write(workspaceIdentity({ log: args[0] }).digest)
  } else if (op === 'validate') {
    const result = parseVerdict(readFileSync(args[0], 'utf8'), Number(args[1]))
    if (!result) process.exit(3)
    process.stdout.write(`${result.verdict} ${result.exit}`)
  } else if (op === 'write') {
    const [stateFile, verdict, code, startJSON, log, command, rendered] = args
    const start = JSON.parse(startJSON), after = observedIdentity({ log })
    const changed = !start.target.digest || !after.digest || start.target.digest !== after.digest
    const finished_at = new Date().toISOString()
    const receipt = writeEvidence(evidenceDir(), {
      kind: 'verification', mode: 'gate', verdict, exit: Number(code), command_hash: start.command_hash,
      root_hash: sha256(realpathSync(process.cwd())), verdict_sha256: sha256(rendered + '\n'),
      identity_policy: { version: 1, loop_dir: resolve(process.env.LOOP_DIR || '.loop'), log: resolve(log) },
      run_id: process.env.LOOP_RUN_ID || null, attempt: Number(process.env.LOOP_ATTEMPT || 0),
      target_before: start.target, target_after: after, started_at: start.started_at, finished_at,
      log_hash: sha256(readFileSync(log)),
      failure_signature: rendered.split('\n').filter(l => /^FAIL:/.test(l)).map(line => sanitizeText(line)).join('\n'),
    })
    const state = { verdict, exit: Number(code), sha: start.target.sha, dirty: start.target.dirty || after.dirty || changed,
      target_changed: changed, finished_at, started_at: start.started_at, cmd: sanitizeText(command).slice(0, 500),
      log: resolve(log), receipt_id: receipt.id, target_before: start.target, target_after: after }
    mkdirSync(dirname(stateFile), { recursive: true })
    const tmp = `${stateFile}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(state) + '\n', { mode: 0o600 })
    renameSync(tmp, stateFile)
  } else throw new Error('unknown verdict-state operation')
} catch (e) { process.stderr.write(`verdict-state: ${e.message}\n`); process.exit(1) }
