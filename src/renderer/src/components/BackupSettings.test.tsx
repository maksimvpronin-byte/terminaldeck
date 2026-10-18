// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import BackupSettings from './BackupSettings'
import { useStore } from '../state/store'

/*
 * A backup carries the saved multi-window layouts, and after an import the
 * window read everything again but those: renaming one then saved the old
 * layout whole over the one just imported.
 */
describe('importing a backup', () => {
  it('reads the saved layouts again with the rest', async () => {
    const loads = Object.fromEntries(
      [
        'loadStore',
        'loadSnippets',
        'loadInventory',
        'loadGitFolders',
        'loadCollections',
        'loadCredentials',
        'loadMultiWindows'
      ].map((name) => [name, vi.fn(async () => undefined)])
    )
    useStore.setState(loads)
    ;(window.td as unknown as { backup: Record<string, unknown> }).backup = {
      importFromFile: vi.fn(async () => ({
        sessions: 0,
        groups: 0,
        snippets: 0,
        collections: 0,
        inventorySources: 0
      }))
    }
    render(<BackupSettings />)

    fireEvent.click(screen.getByText('Import…'))
    await act(async () => {})

    expect(loads.loadMultiWindows).toHaveBeenCalled()
  })
})
