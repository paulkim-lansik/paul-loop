import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'

// POSIX adapter boundary: cap the whole process group, including grandchildren. Timeout or
// cancellation wins over late exit 0. Even normal parent exit cleans lingering descendants.
export function runEvalProcess(command, { cwd, env, input = '', deadline, maxBytes = 4 * 1024 * 1024 }) {
  if (process.platform === 'win32') throw new Error('agent eval requires a POSIX process-group adapter (use WSL on Windows)')
  return new Promise(resolve => {
    if (Date.now() >= deadline) return resolve({ exit: null, fault: 'budget_exhausted', output: '', duration_ms: 0 })
    const start = Date.now(), child = spawn('sh', ['-c', command], { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
    const decoder = new StringDecoder('utf8')
    let output = '', bytes = 0, fault = null, settled = false, cleanupTimer
    const signal = name => { if (child.pid) try { process.kill(-child.pid, name) } catch { /* exited */ } }
    const finish = code => {
      if (settled) return
      settled = true; clearTimeout(timer); clearTimeout(cleanupTimer)
      process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel)
      signal('SIGKILL')
      output += decoder.end()
      resolve({ exit: code, fault, output, duration_ms: Date.now() - start })
    }
    const stop = reason => {
      fault ||= reason; signal('SIGTERM')
      cleanupTimer ||= setTimeout(() => { signal('SIGKILL'); finish(null) }, 250)
    }
    const cancel = () => stop('cancelled')
    process.on('SIGINT', cancel); process.on('SIGTERM', cancel)
    const timer = setTimeout(() => stop('timeout'), Math.max(1, deadline - Date.now()))
    child.on('error', e => { fault = e.code || 'spawn_error'; finish(null) })
    child.stdout.on('data', b => { bytes += b.length; if (bytes > maxBytes) stop('output_limit'); else output += decoder.write(b) })
    child.stderr.on('data', b => { bytes += b.length; if (bytes > maxBytes) stop('output_limit') })
    child.stdin.on('error', () => {})
    child.stdin.end(input)
    child.on('exit', () => { if (Date.now() >= deadline) fault ||= 'timeout'; signal('SIGKILL') })
    child.on('close', code => finish(code))
  })
}
