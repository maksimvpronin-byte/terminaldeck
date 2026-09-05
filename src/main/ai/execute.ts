import type { Client, ClientChannel } from 'ssh2'
import type { DiagnosticResult } from '../../shared/ai'

/** Starts the deadline before opening the channel and closes late channels after cancellation. */
export function executeDiagnostic(
  client: Client,
  command: string,
  signal: AbortSignal,
  timeoutMs = 15000,
  maxBytes = 65536
): Promise<DiagnosticResult> {
  return new Promise((resolve) => {
    const started = Date.now()
    let channel: ClientChannel | undefined
    let settled = false
    let bytes = 0
    let truncated = false
    let exitCode: number | null = null
    let exitSignal: string | undefined
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    const finish = (outcome: DiagnosticResult['outcome']): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', cancel)
      resolve({
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        exitCode,
        signal: exitSignal,
        durationMs: Date.now() - started,
        outcome,
        truncated
      })
      try {
        channel?.close()
      } catch {
        /* Channel already closed. */
      }
    }
    const cancel = (): void => finish('cancelled')
    const timer = setTimeout(() => finish('timeout'), timeoutMs)
    signal.addEventListener('abort', cancel, { once: true })
    if (signal.aborted) {
      cancel()
      return
    }
    const receive = (target: Buffer[], data: Buffer | string): void => {
      if (settled) return
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)
      const remaining = Math.max(0, maxBytes - bytes)
      target.push(buf.subarray(0, remaining))
      bytes += Math.min(buf.length, remaining)
      if (buf.length > remaining) {
        truncated = true
        finish('truncated')
      }
    }
    try {
      client.exec(command, (err, stream) => {
        if (settled) {
          try {
            stream?.on('error', () => undefined)
            stream?.stderr.on('error', () => undefined)
            stream?.close()
          } catch {
            /* Late channel. */
          }
          return
        }
        if (err) {
          receive(stderr, err.message)
          finish('error')
          return
        }
        channel = stream
        stream.on('data', (data: Buffer) => receive(stdout, data))
        stream.stderr.on('data', (data: Buffer) => receive(stderr, data))
        stream.on('exit', (code: number | null, sig?: string) => {
          exitCode = typeof code === 'number' ? code : null
          exitSignal = sig
        })
        stream.on('close', () => finish('completed'))
        stream.on('error', (error: Error) => {
          receive(stderr, error.message)
          finish('error')
        })
        stream.stderr.on('error', (error: Error) => {
          receive(stderr, error.message)
          finish('error')
        })
      })
    } catch (error) {
      receive(stderr, String(error))
      finish('error')
    }
  })
}
