import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({ app: {}, ipcMain: { handle: vi.fn() } }))
vi.mock('./diagnostics', () => ({ diag: vi.fn() }))

import { keyboardLayoutFor } from './inputLanguage'

describe('keyboardLayoutFor', () => {
  it('names the Windows layout a Mac language starts a session in', () => {
    expect(keyboardLayoutFor('en')).toBe(0x0409)
    expect(keyboardLayoutFor('ru')).toBe(0x0419)
    expect(keyboardLayoutFor('RU')).toBe(0x0419)
  })

  it('leaves the server to pick for a language it has no plain layout for', () => {
    expect(keyboardLayoutFor('zh')).toBeUndefined()
    expect(keyboardLayoutFor(null)).toBeUndefined()
    expect(keyboardLayoutFor(undefined)).toBeUndefined()
  })
})
