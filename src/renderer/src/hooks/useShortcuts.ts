import { useEffect, useRef } from 'react'
import { useStore, activeTab, activeWorkspace, type PaneNode } from '../state/store'
import { findHost, type FoundHost } from '../state/hosts'
import { DEFAULT_SETTINGS } from '../state/settings'

const IDLE_LOCK_MS = 15 * 60 * 1000

function clampFontSize(size: number): number {
  return Math.min(32, Math.max(8, size))
}

/**
 * Window-level shortcuts. Registered in the capture phase so they win over
 * xterm.js, which otherwise swallows the keystroke into the remote shell.
 */
export function useShortcuts(actions: {
  openSnippets: () => void
  openHelp: () => void
  openHosts: () => void
}): void {
  const openSnippetsRef = useRef(actions.openSnippets)
  openSnippetsRef.current = actions.openSnippets
  const openHelpRef = useRef(actions.openHelp)
  openHelpRef.current = actions.openHelp
  const openHostsRef = useRef(actions.openHosts)
  openHostsRef.current = actions.openHosts

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      const mod = e.metaKey || e.ctrlKey
      if (!mod) return

      const state = useStore.getState()
      const current = activeTab(state)
      const workspace = activeWorkspace(state)
      const key = e.key.toLowerCase()

      // Cmd/Ctrl+1..9 jumps to the Nth tab, with Shift to the Nth workspace.
      // Keyed off e.code rather than e.key: with Shift held a digit arrives as
      // '!' or '"' depending on the layout, and the physical key is what counts.
      const digit = /^Digit([1-9])$/.exec(e.code)
      if (digit) {
        const index = Number(digit[1]) - 1
        const target = e.shiftKey ? state.workspaces[index] : workspace?.tabs[index]
        if (target) {
          e.preventDefault()
          e.stopPropagation()
          if (e.shiftKey) state.setActiveWorkspace(target.id)
          else state.setActiveTab(target.id)
        }
        return
      }

      switch (key) {
        case 't': {
          // Duplicate the active pane's target into a fresh tab.
          if (!current) return
          const leaf = findLeaf(current.root, current.activePaneId)
          if (!leaf) return
          e.preventDefault()
          e.stopPropagation()
          state.openTab(leaf.title, leaf.target)
          break
        }
        case 'w': {
          if (!current) return
          e.preventDefault()
          e.stopPropagation()
          // Close just the focused pane while the tab is split; otherwise the tab.
          if (current.root.type === 'split') state.closePane(current.id, current.activePaneId)
          else state.closeTab(current.id)
          break
        }
        case 'd': {
          if (!current) return
          e.preventDefault()
          e.stopPropagation()
          state.splitPane(current.id, current.activePaneId, e.shiftKey ? 'col' : 'row')
          break
        }
        case 'l': {
          e.preventDefault()
          e.stopPropagation()
          state.lockVault()
          break
        }
        case 'k': {
          e.preventDefault()
          e.stopPropagation()
          openSnippetsRef.current()
          break
        }
        case 'p': {
          e.preventDefault()
          e.stopPropagation()
          openHostsRef.current()
          break
        }
        // Zoom keys never reach here: main claims them before Chromium's own
        // page zoom can, and drives the font size through the uiZoom event.
        case '/':
        case '?': {
          e.preventDefault()
          e.stopPropagation()
          openHelpRef.current()
          break
        }
        default:
          break
      }
    }

    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [])
}

/**
 * The host whose terminal is focused, when it carries a font size of its own.
 * Zoom has to edit that one, because a host that overrides the size would
 * otherwise sit unmoved while every other terminal resized around it.
 */
function focusedHostWithOwnFontSize(): FoundHost | undefined {
  const state = useStore.getState()
  const tab = activeTab(state)
  if (!tab) return undefined
  const leaf = findLeaf(tab.root, tab.activePaneId)
  if (leaf?.target.kind !== 'session') return undefined
  const found = findHost(state, leaf.target.sessionId)
  // Only an existing explicit size is followed; zoom never invents an override
  // on a host that was happily using the global setting.
  return found && found.host.fontSize !== undefined ? found : undefined
}

async function zoomHost(found: FoundHost, direction: 'in' | 'out' | 'reset'): Promise<void> {
  const state = useStore.getState()
  const size =
    direction === 'reset'
      ? undefined
      : clampFontSize((found.host.fontSize ?? state.settings.fontSize) + (direction === 'in' ? 1 : -1))

  if (found.fromInventory) {
    const existing = state.inventoryOverrides.find((o) => o.nodeId === found.host.id)
    await state.saveInventoryOverride({ ...existing, nodeId: found.host.id, fontSize: size })
  } else {
    await state.upsertSession({ ...found.host, fontSize: size, updatedAt: Date.now() })
  }
}

/** Applies the terminal font zoom that the main process intercepted for us. */
export function useZoom(): void {
  useEffect(() => {
    return window.td.ui.onZoom((direction) => {
      const own = focusedHostWithOwnFontSize()
      // Reset drops the host's own size so it follows the global default again.
      if (own) {
        void zoomHost(own, direction)
        return
      }
      const { settings, updateSettings } = useStore.getState()
      if (direction === 'reset') updateSettings({ fontSize: DEFAULT_SETTINGS.fontSize })
      else {
        updateSettings({
          fontSize: clampFontSize(settings.fontSize + (direction === 'in' ? 1 : -1))
        })
      }
    })
  }, [])
}

/** Locks the vault after a stretch of no keyboard or pointer activity. */
export function useIdleLock(): void {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>

    function reset(): void {
      clearTimeout(timer)
      timer = setTimeout(() => {
        if (!useStore.getState().vaultLocked) useStore.getState().lockVault()
      }, IDLE_LOCK_MS)
    }

    const events: Array<keyof WindowEventMap> = ['keydown', 'mousemove', 'mousedown', 'wheel']
    for (const evt of events) window.addEventListener(evt, reset, true)
    reset()

    return () => {
      clearTimeout(timer)
      for (const evt of events) window.removeEventListener(evt, reset, true)
    }
  }, [])
}

type LeafNode = Extract<PaneNode, { type: 'leaf' }>

function findLeaf(node: PaneNode, id: string): LeafNode | undefined {
  if (node.type === 'leaf') return node.id === id ? node : undefined
  return findLeaf(node.children[0], id) ?? findLeaf(node.children[1], id)
}
