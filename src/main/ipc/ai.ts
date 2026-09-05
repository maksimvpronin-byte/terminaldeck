import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import type { AiSettingsInput } from '../../shared/ai'
import { requireUnlocked } from '../vault/locked'
import { sshManager } from '../ssh/SSHManager'
import {
  aiManager,
  aiSettings,
  saveAiSettings,
  clearAiSettings,
  testAiSettings,
  providerConfig
} from '../ai/service'

function own(event: IpcMainInvokeEvent, id: unknown): asserts id is string {
  requireUnlocked()
  if (typeof id !== 'string' || id.length > 100) throw new Error('Invalid connection')
  const target = sshManager.diagnosticTarget(id)
  if (!target || target.sender !== event.sender)
    throw new Error('Connection does not belong to this window')
}
export function registerAiHandlers(): void {
  ipcMain.handle(IPC.aiSettings, () => aiSettings())
  ipcMain.handle(IPC.aiSave, (_e, input: AiSettingsInput) => saveAiSettings(input))
  ipcMain.handle(IPC.aiClear, () => clearAiSettings())
  ipcMain.handle(IPC.aiTest, () => testAiSettings())
  ipcMain.handle(IPC.aiStart, (e, id: string, language: unknown) => {
    own(e, id)
    if (language !== 'en' && language !== 'ru') throw new Error('Invalid language')
    return aiManager.start(id, language, providerConfig())
  })
  ipcMain.handle(IPC.aiGet, (e, id: string) => {
    own(e, id)
    return aiManager.get(id)
  })
  ipcMain.handle(
    IPC.aiDecide,
    (e, id: string, analysisId: string, stepId: string, action: 'approve' | 'skip') => {
      own(e, id)
      return aiManager.decide(id, analysisId, stepId, action)
    }
  )
  ipcMain.handle(IPC.aiReport, (e, id: string, analysisId: string) => {
    own(e, id)
    return aiManager.report(id, analysisId)
  })
  ipcMain.handle(IPC.aiStop, (e, id: string) => {
    own(e, id)
    aiManager.stop(id)
  })
}
