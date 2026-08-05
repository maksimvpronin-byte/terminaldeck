import type { StateCreator } from 'zustand'
import { loadSettings, saveSettings } from '../settings'
import type { AppState, SettingsSlice } from './types'

export const createSettingsSlice: StateCreator<AppState, [], [], SettingsSlice> = (set) => ({
  settings: loadSettings(),

  updateSettings: (patch) =>
    set((s) => {
      const settings = { ...s.settings, ...patch }
      saveSettings(settings)
      return { settings }
    })
})
