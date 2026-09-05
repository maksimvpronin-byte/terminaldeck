import { BrowserWindow } from 'electron'
import { vault } from '../vault/Vault'
import { requireUnlocked } from '../vault/locked'
import { sshManager } from '../ssh/SSHManager'
import { IPC } from '../../shared/ipc-channels'
import type { AiSettings, AiSettingsInput } from '../../shared/ai'
import { AnalysisManager } from './AnalysisManager'
import { executeDiagnostic } from './execute'
import { chat, validateSettings, type ProviderConfig } from './provider'

const REF = 'terminaldeck:ai:provider'
const tests = new Set<AbortController>()
export function providerConfig(): ProviderConfig {
  requireUnlocked()
  const stored = vault.getSecret(REF)
  if (!stored)
    return { endpoint: 'https://api.openai.com/v1', model: '', apiKey: '', consent: false }
  const parsed = JSON.parse(stored)
  return validateSettings(parsed)
}
export function aiSettings(): AiSettings {
  const { apiKey, ...publicSettings } = providerConfig()
  return { ...publicSettings, keyPresent: !!apiKey }
}
export function saveAiSettings(input: AiSettingsInput): AiSettings {
  const config = validateSettings(input, providerConfig())
  stopAi()
  vault.setSecret(REF, JSON.stringify(config))
  return aiSettings()
}
export function clearAiSettings(): AiSettings {
  requireUnlocked()
  stopAi()
  vault.deleteSecret(REF)
  return aiSettings()
}
export async function testAiSettings(): Promise<void> {
  const config = providerConfig()
  if (!config.apiKey || !config.model) throw new Error('Configure API key and model first')
  const controller = new AbortController()
  tests.add(controller)
  try {
    await chat(
      config,
      [
        {
          role: 'user',
          content: 'Reply with OK. This is an API connection test; no server data is included.'
        }
      ],
      controller.signal
    )
  } finally {
    config.apiKey = ''
    tests.delete(controller)
  }
}
export const aiManager = new AnalysisManager({
  check: (id) => {
    requireUnlocked()
    const target = sshManager.diagnosticTarget(id)
    if (!target) throw new Error('SSH connection is closed')
    return target.host
  },
  execute: (id, command, signal, maxBytes, timeoutMs) => {
    requireUnlocked()
    const chain = sshManager.getClientChain(id)
    if (!chain?.length) throw new Error('SSH connection is closed')
    return executeDiagnostic(chain[chain.length - 1], command, signal, timeoutMs, maxBytes)
  },
  model: chat,
  update: (analysis) => {
    const target = sshManager.diagnosticTarget(analysis.connectionId)
    const win = target && BrowserWindow.fromWebContents(target.sender)
    if (win && !win.isDestroyed()) win.webContents.send(IPC.aiUpdate, analysis)
  }
})
export function stopAi(): void {
  aiManager.stopAll()
  for (const test of tests) test.abort()
}
sshManager.onDiagnosticDisconnect((id) => aiManager.remove(id))
