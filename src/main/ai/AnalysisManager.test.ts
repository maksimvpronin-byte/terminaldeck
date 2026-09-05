import { describe, it, expect, vi } from 'vitest'
import { AnalysisManager, type AnalysisDependencies } from './AnalysisManager'
import type { AiAnalysis, DiagnosticResult } from '../../shared/ai'
import type { ProviderConfig } from './provider'

const config: ProviderConfig = {
  endpoint: 'https://example.org/v1',
  model: 'test',
  apiKey: 'test-secret',
  consent: true
}
const result: DiagnosticResult = {
  stdout: 'NAME=Linux',
  stderr: '',
  exitCode: 0,
  durationMs: 1,
  outcome: 'completed',
  truncated: false
}
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}
function fixture() {
  const execute = vi.fn<AnalysisDependencies['execute']>().mockResolvedValue(result)
  const model = vi.fn<AnalysisDependencies['model']>().mockResolvedValue(
    JSON.stringify({
      explanation: 'Check load next',
      next: { tool: 'uptime', reason: 'Measure load' }
    })
  )
  const update = vi.fn<(view: AiAnalysis) => void>()
  const check = vi.fn(() => 'server.example.org')
  const manager = new AnalysisManager({ check, execute, model, update })
  const analysis = manager.start('conn', 'en', config)
  return { execute, model, update, check, manager, analysis }
}
describe('manual command approval', () => {
  it('starts with an ordered plan and does not execute or contact the model', () => {
    const f = fixture()
    expect(f.analysis.status).toBe('awaiting')
    expect(f.analysis.steps.filter((s) => s.status === 'pending')).toHaveLength(1)
    expect(f.execute).not.toHaveBeenCalled()
    expect(f.model).not.toHaveBeenCalled()
  })
  it('consumes approval before awaiting and never runs the next proposal', async () => {
    const f = fixture()
    const pending = deferred<DiagnosticResult>()
    f.execute.mockReturnValueOnce(pending.promise)
    const first = f.manager.decide('conn', f.analysis.id, f.analysis.steps[0].id, 'approve')
    await expect(
      f.manager.decide('conn', f.analysis.id, f.analysis.steps[0].id, 'approve')
    ).rejects.toThrow()
    pending.resolve(result)
    await first
    expect(f.execute).toHaveBeenCalledTimes(1)
    const view = f.manager.get('conn')!
    expect(view.steps[0].approvedAt).toBeTypeOf('number')
    expect(view.steps[1].status).toBe('pending')
    expect(view.status).toBe('awaiting')
  })
  it('skips without command execution or cloud request and records the omission', async () => {
    const f = fixture()
    await f.manager.decide('conn', f.analysis.id, f.analysis.steps[0].id, 'skip')
    expect(f.execute).not.toHaveBeenCalled()
    expect(f.model).not.toHaveBeenCalled()
    expect(f.manager.get('conn')!.steps[0].status).toBe('skipped')
  })
  it('rejects queued commands, stale runs and altered decisions', async () => {
    const f = fixture()
    await expect(
      f.manager.decide('conn', f.analysis.id, f.analysis.steps[1].id, 'approve')
    ).rejects.toThrow()
    await expect(
      f.manager.decide('conn', 'old', f.analysis.steps[0].id, 'approve')
    ).rejects.toThrow()
    f.manager.start('conn', 'en', config)
    await expect(
      f.manager.decide('conn', f.analysis.id, f.analysis.steps[0].id, 'approve')
    ).rejects.toThrow()
    expect(f.execute).not.toHaveBeenCalled()
  })
  it('stopping during exec aborts the channel and ignores its late result', async () => {
    const f = fixture()
    const pending = deferred<DiagnosticResult>()
    f.execute.mockReturnValueOnce(pending.promise)
    const operation = f.manager.decide('conn', f.analysis.id, f.analysis.steps[0].id, 'approve')
    f.manager.stop('conn')
    expect(f.execute.mock.calls[0][2].aborted).toBe(true)
    pending.resolve(result)
    await operation
    expect(f.model).not.toHaveBeenCalled()
    expect(f.manager.get('conn')!.status).toBe('stopped')
  })
  it('lock cancels provider requests and cannot reopen a proposal after unlock', async () => {
    const f = fixture()
    const pending = deferred<string>()
    f.model.mockReturnValueOnce(pending.promise)
    const operation = f.manager.decide('conn', f.analysis.id, f.analysis.steps[0].id, 'approve')
    await vi.waitFor(() => expect(f.model).toHaveBeenCalled())
    f.manager.stopAll()
    expect(f.model.mock.calls[0][2].aborted).toBe(true)
    pending.resolve(
      JSON.stringify({ explanation: 'Continue', next: { tool: 'uptime', reason: 'next' } })
    )
    await operation
    await expect(
      f.manager.decide('conn', f.analysis.id, f.analysis.steps[1].id, 'approve')
    ).rejects.toThrow()
    expect(f.manager.get('conn')!.status).toBe('stopped')
  })
  it('rechecks connection/lock before executing', async () => {
    const f = fixture()
    f.check.mockImplementation(() => {
      throw new Error('locked')
    })
    await expect(
      f.manager.decide('conn', f.analysis.id, f.analysis.steps[0].id, 'approve')
    ).rejects.toThrow('locked')
    expect(f.execute).not.toHaveBeenCalled()
  })
  it.each([
    { tool: 'shell', parameter: 'reboot' },
    { tool: 'service_logs', parameter: 'nginx.service; reboot' },
    { tool: 'os' },
    { tool: 'smart', parameter: '/dev/sda; curl bad' }
  ])('refuses invalid or repeated AI proposals: %j', async (next) => {
    const f = fixture()
    f.model.mockResolvedValueOnce(
      JSON.stringify({ explanation: 'Bad', next: { ...next, reason: 'test' } })
    )
    await f.manager.decide('conn', f.analysis.id, f.analysis.steps[0].id, 'approve')
    expect(f.execute).toHaveBeenCalledTimes(1)
    expect(f.manager.get('conn')!.status).toBe('error')
  })
  it('proposes a service log command without running it', async () => {
    const f = fixture()
    f.model.mockResolvedValueOnce(
      JSON.stringify({
        explanation: 'Service failure',
        next: { tool: 'service_logs', parameter: 'nginx.service', reason: 'Inspect failure' }
      })
    )
    await f.manager.decide('conn', f.analysis.id, f.analysis.steps[0].id, 'approve')
    const proposal = f.manager.get('conn')!.steps.find((s) => s.status === 'pending')!
    expect(proposal.command).toContain("-u 'nginx.service'")
    expect(f.execute).toHaveBeenCalledTimes(1)
  })
  it('produces a report only with existing evidence and records skipped checks', async () => {
    const f = fixture()
    await f.manager.decide('conn', f.analysis.id, f.analysis.steps[0].id, 'approve')
    f.model.mockResolvedValueOnce(
      JSON.stringify({
        explanation: 'Partial',
        report: {
          summary: 'Partial',
          findings: [
            {
              severity: 'info',
              observation: 'Linux',
              hypothesis: 'Unknown',
              recommendation: 'Review',
              evidence: [f.analysis.steps[0].id]
            }
          ],
          limitations: []
        }
      })
    )
    await f.manager.report('conn', f.analysis.id)
    const view = f.manager.get('conn')!
    expect(view.status).toBe('complete')
    expect(view.report!.limitations.length).toBeGreaterThan(5)
    expect(f.execute).toHaveBeenCalledTimes(1)
  })
  it('an early model report does not silently skip the base plan', async () => {
    const f = fixture()
    f.model.mockResolvedValueOnce(
      JSON.stringify({
        explanation: 'Not enough data',
        report: { summary: 'Unknown', findings: [], limitations: ['Incomplete'] }
      })
    )
    await f.manager.decide('conn', f.analysis.id, f.analysis.steps[0].id, 'approve')
    expect(f.manager.get('conn')!.status).toBe('awaiting')
    expect(f.manager.get('conn')!.report).toBeUndefined()
  })
  it('snapshots cannot mutate stored command text or authorize future executions', () => {
    const f = fixture()
    f.analysis.steps[0].command = 'reboot'
    expect(f.manager.get('conn')!.steps[0].command).toBe('cat /etc/os-release')
  })
})
