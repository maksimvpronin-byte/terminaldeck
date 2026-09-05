/** Only main can turn a proposal into an SSH command. No API accepts command text. */
export interface AiSettings {
  endpoint: string
  model: string
  keyPresent: boolean
  consent: boolean
}
export interface AiSettingsInput {
  endpoint: string
  model: string
  apiKey?: string
  consent: boolean
}
export interface DiagnosticResult {
  stdout: string
  stderr: string
  exitCode: number | null
  signal?: string
  durationMs: number
  outcome: 'completed' | 'timeout' | 'cancelled' | 'error' | 'truncated'
  truncated: boolean
}
export interface DiagnosticCommand {
  tool: string
  parameter?: string
  command: string
  title: string
  purpose: string
  rights: string
  impact: string
  timeoutMs: number
}
export interface AiStep extends DiagnosticCommand {
  id: string
  reason: string
  status: 'queued' | 'pending' | 'running' | 'completed' | 'skipped' | 'cancelled'
  proposedAt: number
  approvedAt?: number
  result?: DiagnosticResult
}
export interface AiFinding {
  severity: 'info' | 'warning' | 'critical'
  observation: string
  hypothesis: string
  recommendation: string
  evidence: string[]
}
export interface AiReport {
  summary: string
  findings: AiFinding[]
  limitations: string[]
}
export interface AiAnalysis {
  id: string
  revision: number
  connectionId: string
  host: string
  language: 'en' | 'ru'
  startedAt: number
  finishedAt?: number
  status: 'awaiting' | 'running' | 'thinking' | 'complete' | 'stopped' | 'error'
  steps: AiStep[]
  explanation: string
  report?: AiReport
  error?: string
  modelRequests: number
  activeMs: number
  dataBytes: number
  provider: string
  model: string
}
