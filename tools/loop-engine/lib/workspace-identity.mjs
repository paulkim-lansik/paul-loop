import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readlinkSync, realpathSync } from 'node:fs'
import { resolve, relative, sep } from 'node:path'

export const sha256 = value => createHash('sha256').update(value).digest('hex')

// Git-visible end-state identity, including untracked contents and symlinks. Every Git/read
// failure propagates; a failed enumeration must never collapse to the hash of an empty stream.
// This does not detect a mutation that is completely restored before the ending snapshot.
export function workspaceIdentity({ cwd = process.cwd(), loopDir = process.env.LOOP_DIR || '.loop', log = '', visited = new Set(), requireRoot = false } = {}) {
  const git = (...args) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 128 * 1024 * 1024 })
  const requested = realpathSync(cwd), root = realpathSync(git('rev-parse', '--show-toplevel').toString().trim())
  if (requireRoot && requested !== root) throw new Error('submodule is not initialized')
  loopDir = resolve(cwd, loopDir); log = log ? resolve(cwd, log) : ''; cwd = root
  if (visited.has(root)) throw new Error('cyclic workspace identity')
  visited.add(root)
  const loopAbs = resolve(cwd, loopDir), logAbs = log ? resolve(cwd, log) : ''
  const excludedUntracked = f => {
    const abs = resolve(cwd, f), rel = relative(loopAbs, abs)
    return abs === logAbs || rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !rel.startsWith(sep))
  }
  const sha = git('rev-parse', 'HEAD').toString().trim()
  // Expand untracked directories before filtering runtime outputs. Otherwise the first receipt
  // changes its own identity (or status.showUntrackedFiles changes the identity policy).
  const entries = git('status', '--porcelain=v1', '-z', '--untracked-files=all').toString().split('\0').filter(Boolean)
  const keptStatus = []
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    if (entry.startsWith('?? ') && excludedUntracked(entry.slice(3))) continue
    keptStatus.push(entry)
    if (/^[RC]|^.[RC]/.test(entry.slice(0, 2))) keptStatus.push(entries[++i]) // rename/copy source path is the next NUL record
  }
  const status = Buffer.from(keptStatus.length ? keptStatus.join('\0') + '\0' : '')
  const hash = createHash('sha256')
  const add = value => { const b = Buffer.from(value); hash.update(String(b.length) + ':'); hash.update(b) }
  add(sha); add(status); add(git('diff', '--binary', '--no-ext-diff', '--no-textconv', 'HEAD'))
  for (const entry of git('ls-files', '--stage', '-z').toString().split('\0')) {
    if (!entry.startsWith('160000 ')) continue
    const path = entry.slice(entry.indexOf('\t') + 1)
    add(path)
    add(JSON.stringify(workspaceIdentity({ cwd: resolve(cwd, path), loopDir, log, visited, requireRoot: true })))
  }
  for (const f of git('ls-files', '-o', '--exclude-standard', '-z').toString().split('\0').filter(Boolean).sort()) {
    const abs = resolve(cwd, f)
    if (excludedUntracked(f)) continue
    const st = lstatSync(abs)
    if (!st.isSymbolicLink() && !st.isFile()) throw new Error(`unsupported untracked file type: ${f}`)
    add(f); add(String(st.mode))
    add(st.isSymbolicLink() ? readlinkSync(abs) : readFileSync(abs))
  }
  return { sha, dirty: status.length > 0, digest: hash.digest('hex') }
}

export function observedIdentity(options) {
  try { return workspaceIdentity(options) }
  catch { return { sha: 'unknown', dirty: true, digest: null, unavailable: true } }
}
