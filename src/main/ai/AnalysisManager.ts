import { randomUUID } from 'crypto'
import type { AiAnalysis, AiStep, DiagnosticResult } from '../../shared/ai'
import { BASE_TOOLS, diagnosticCommand } from './catalog'
import { modelMessages, parseDecision, redact, type ProviderConfig } from './provider'

export interface AnalysisDependencies {
  check: (connectionId: string) => string
  execute: (
    connectionId: string,
    command: string,
    signal: AbortSignal,
    maxBytes: number,
    timeoutMs: number
  ) => Promise<DiagnosticResult>
  model: (
    config: ProviderConfig,
    messages: { role: string; content: string }[],
    signal: AbortSignal
  ) => Promise<string>
  update: (analysis: AiAnalysis) => void
}
interface Run {
  view: AiAnalysis
  config: ProviderConfig
  controller: AbortController
  reservedBytes: number
}
const ACTIVE_LIMIT = 300000
const DATA_LIMIT = 512 * 1024
const MODEL_LIMIT = 24

export class AnalysisManager {
  private runs = new Map<string, Run>()
  constructor(private deps: AnalysisDependencies) {}
  private emit(run: Run): void {
    run.view.revision++
    this.deps.update(structuredClone(run.view))
  }
  private step(tool: string, parameter: unknown, language: 'en' | 'ru', reason: string): AiStep {
    return {
      ...diagnosticCommand(tool, parameter, language),
      id: randomUUID(),
      reason,
      status: 'queued',
      proposedAt: Date.now()
    }
  }
  start(connectionId: string, language: 'en' | 'ru', config: ProviderConfig): AiAnalysis {
    const host = this.deps.check(connectionId)
    if (!config.consent || !config.apiKey || !config.model)
      throw new Error('Configure AI and allow diagnostic data transfer first')
    if (this.runs.has(connectionId)) this.stop(connectionId)
    if (this.runs.size >= 32 && !this.runs.has(connectionId))
      throw new Error('Too many analysis sessions; close an SSH session first')
    const reason =
      language === 'ru' ? 'Базовая проверка состояния машины' : 'Baseline machine health check'
    const steps = BASE_TOOLS.map((tool) => this.step(tool, undefined, language, reason))
    steps[0].status = 'pending'
    const view: AiAnalysis = {
      id: randomUUID(),
      revision: 0,
      connectionId,
      host,
      language,
      startedAt: Date.now(),
      status: 'awaiting',
      steps,
      explanation: reason,
      modelRequests: 0,
      activeMs: 0,
      dataBytes: 0,
      provider: config.endpoint,
      model: config.model
    }
    const run = { view, config: { ...config }, controller: new AbortController(), reservedBytes: 0 }
    this.runs.set(connectionId, run)
    this.emit(run)
    return structuredClone(view)
  }
  get(connectionId: string): AiAnalysis | null {
    const run = this.runs.get(connectionId)
    return run ? structuredClone(run.view) : null
  }
  private current(connectionId: string, id: string): Run {
    this.deps.check(connectionId)
    const run = this.runs.get(connectionId)
    if (!run || run.view.id !== id || run.controller.signal.aborted)
      throw new Error('Analysis is no longer active')
    return run
  }
  private alive(run: Run): boolean {
    return !run.controller.signal.aborted && this.runs.get(run.view.connectionId) === run
  }
  async decide(
    connectionId: string,
    id: string,
    stepId: string,
    action: 'approve' | 'skip'
  ): Promise<void> {
    const run = this.current(connectionId, id)
    const step = run.view.steps.find((s) => s.id === stepId)
    if (run.view.status !== 'awaiting' || step?.status !== 'pending')
      throw new Error('Command is not awaiting confirmation')
    if (action !== 'approve' && action !== 'skip') throw new Error('Invalid decision')
    if (action === 'skip') {
      step.status = 'skipped'
      this.nextBase(run)
      return
    }
    if (run.view.activeMs >= ACTIVE_LIMIT || run.view.dataBytes >= DATA_LIMIT) {
      this.fail(run, 'Diagnostic budget exhausted')
      return
    }
    // Consume confirmation before the first await: duplicate IPC cannot execute again.
    step.status = 'running'
    step.approvedAt = Date.now()
    run.view.status = 'running'
    this.emit(run)
    const started = Date.now()
    try {
      const result = await this.deps.execute(
        connectionId,
        step.command,
        run.controller.signal,
        Math.min(65536, DATA_LIMIT - run.view.dataBytes),
        Math.min(15000, ACTIVE_LIMIT - run.view.activeMs)
      )
      if (!this.alive(run)) return
      this.deps.check(connectionId)
      run.view.activeMs += Date.now() - started
      run.view.dataBytes += Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)
      step.result = {
        ...result,
        stdout: redact(result.stdout, [run.config.apiKey]),
        stderr: redact(result.stderr, [run.config.apiKey])
      }
      step.status = 'completed'
      await this.think(run, false)
    } catch {
      if (this.alive(run)) {
        step.status = 'cancelled'
        this.fail(
          run,
          'Analysis failed; inspect the connection or AI settings. Collected results are retained.'
        )
      }
    }
  }
  private nextBase(run: Run): void {
    const next = run.view.steps.find((s) => s.status === 'queued')
    if (next) {
      next.status = 'pending'
      run.view.status = 'awaiting'
      this.emit(run)
    } else {
      void this.think(run, true).catch(() => {
        if (this.alive(run)) this.fail(run, 'Could not generate the report')
      })
    }
  }
  async report(connectionId: string, id: string): Promise<void> {
    const run = this.current(connectionId, id)
    if (run.view.status !== 'awaiting') throw new Error('Wait for the current operation')
    for (const s of run.view.steps)
      if (s.status === 'queued' || s.status === 'pending') s.status = 'skipped'
    await this.think(run, true)
  }
  private async think(run: Run, finalOnly: boolean): Promise<void> {
    if (!this.alive(run)) return
    this.deps.check(run.view.connectionId)
    if (
      run.view.activeMs >= ACTIVE_LIMIT ||
      run.view.dataBytes >= DATA_LIMIT ||
      run.view.modelRequests >= MODEL_LIMIT
    ) {
      this.fail(run, 'Analysis budget exhausted; collected results are retained')
      return
    }
    const messages = modelMessages(run.view, finalOnly, run.config.apiKey)
    // Byte accounting conservatively bounds repeated input as well as output reservations.
    const reservation = Buffer.byteLength(JSON.stringify(messages)) + 12000
    if (run.reservedBytes + reservation > 512 * 1024) {
      this.fail(run, 'AI context budget exhausted; collected results are retained')
      return
    }
    run.reservedBytes += reservation
    run.view.modelRequests++
    run.view.status = 'thinking'
    this.emit(run)
    const started = Date.now()
    try {
      const content = await this.deps.model(
        run.config,
        messages,
        AbortSignal.any([
          run.controller.signal,
          AbortSignal.timeout(Math.max(1, ACTIVE_LIMIT - run.view.activeMs))
        ])
      )
      if (!this.alive(run)) return
      this.deps.check(run.view.connectionId)
      run.view.activeMs += Date.now() - started
      const decision = parseDecision(content, run.view, finalOnly)
      run.view.explanation = decision.explanation
      if (decision.report) {
        // A model cannot silently omit the unperformed base plan.
        if (!finalOnly && run.view.steps.some((s) => s.status === 'queued')) {
          this.nextBase(run)
          return
        }
        run.view.report = decision.report
        for (const s of run.view.steps)
          if (s.status === 'skipped')
            run.view.report.limitations.push(
              `${s.title}: ${run.view.language === 'ru' ? 'пропущено администратором' : 'skipped by administrator'}`
            )
        for (const s of run.view.steps) {
          if (s.result && (s.result.outcome !== 'completed' || s.result.exitCode !== 0)) {
            run.view.report.limitations.push(
              `${s.title}: ${s.result.outcome}, exit=${s.result.exitCode ?? 'unknown'}`
            )
          }
        }
        run.view.report.limitations.push(
          run.view.language === 'ru'
            ? 'Модели передаются ограниченные фрагменты вывода. Полные сохранённые результаты доступны в истории; короткая диагностика не доказывает исправность машины.'
            : 'The model receives limited output excerpts. Retained results are available in history; a short diagnostic run does not prove the machine is healthy.'
        )
        run.view.status = 'complete'
        run.view.finishedAt = Date.now()
        run.config.apiKey = ''
        this.emit(run)
        return
      }
      const next = decision.next!
      let proposal = run.view.steps.find(
        (s) => s.tool === next.tool && s.parameter === (next.parameter || undefined)
      )
      if (proposal && proposal.status !== 'queued') throw new Error('Repeated command proposal')
      if (!proposal) {
        if (run.view.steps.length >= BASE_TOOLS.length + 10)
          throw new Error('Too many follow-up commands')
        proposal = this.step(next.tool, next.parameter, run.view.language, next.reason)
        run.view.steps.push(proposal)
      }
      // Keep the visible sequence in actual execution order as the model reprioritizes.
      const oldIndex = run.view.steps.indexOf(proposal)
      run.view.steps.splice(oldIndex, 1)
      const queuedIndex = run.view.steps.findIndex((s) => s.status === 'queued')
      run.view.steps.splice(queuedIndex < 0 ? run.view.steps.length : queuedIndex, 0, proposal)
      proposal.proposedAt = Date.now()
      proposal.reason = next.reason
      proposal.status = 'pending'
      run.view.status = 'awaiting'
      this.emit(run)
    } catch {
      if (this.alive(run))
        this.fail(
          run,
          'AI request failed or returned an invalid proposal/report. Check settings; no additional command was executed.'
        )
    }
  }
  private fail(run: Run, message: string): void {
    run.view.status = 'error'
    run.view.error = message
    run.view.finishedAt = Date.now()
    run.controller.abort()
    run.config.apiKey = ''
    this.emit(run)
  }
  stop(connectionId: string): void {
    const run = this.runs.get(connectionId)
    if (!run) return
    run.controller.abort()
    run.config.apiKey = ''
    if (['complete', 'error', 'stopped'].includes(run.view.status)) return
    for (const s of run.view.steps)
      if (['pending', 'queued', 'running'].includes(s.status)) s.status = 'cancelled'
    run.view.status = 'stopped'
    run.view.finishedAt = Date.now()
    this.emit(run)
  }
  stopAll(): void {
    for (const id of this.runs.keys()) this.stop(id)
  }
  remove(connectionId: string): void {
    this.stop(connectionId)
    this.runs.delete(connectionId)
  }
}
