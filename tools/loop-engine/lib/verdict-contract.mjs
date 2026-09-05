// Parse the complete nested contract. A nested wrapper normalizes its process exit to 0/1,
// while EXIT retains the underlying verifier's code. No other disagreement is accepted.
export function parseVerdict(text, processExit) {
  const lines = text.trimEnd().split('\n')
  if (lines[0] !== '=== VERDICT ===') return null
  const one = prefix => lines.filter(l => l.startsWith(prefix))
  if (lines.at(-1) !== '=== END VERDICT ===' || one('=== VERDICT ===').length !== 1 || one('=== END VERDICT ===').length !== 1) throw new Error('incomplete or multiple verdict blocks')
  for (const key of ['VERDICT: ', 'EXIT: ', 'SUMMARY: ', 'LOG: ']) if (one(key).length !== 1) throw new Error(`expected one ${key.trim()} field`)
  if (lines.slice(1, -1).some(l => !/^(VERDICT|EXIT|SUMMARY|FAIL|LOG|NOTE): /.test(l))) throw new Error('unknown content inside verdict block')
  const verdict = one('VERDICT: ')[0].slice(9), raw = one('EXIT: ')[0].slice(6)
  if (!['PASS', 'FAIL'].includes(verdict) || !/^\d+$/.test(raw) || Number(raw) > 255) throw new Error('invalid verdict or exit')
  const code = Number(raw), normalized = verdict === 'PASS' ? 0 : 1
  if ((code === 0) !== (verdict === 'PASS') || (processExit === 0) !== (verdict === 'PASS') || ![code, normalized].includes(processExit)) throw new Error('nested verdict disagrees with command exit')
  if (verdict === 'PASS' && one('FAIL: ').length) throw new Error('PASS contains failure reasons')
  if (verdict === 'FAIL' && !one('FAIL: ').length) throw new Error('FAIL requires a reason')
  if (!one('LOG: ')[0].slice(5).startsWith('/')) throw new Error('LOG must be absolute')
  return { verdict, exit: code, processExit: normalized }
}
