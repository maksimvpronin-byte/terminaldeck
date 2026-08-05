import { useEffect, useRef } from 'react'
import { useStore, type PaneNode } from '../state/store'
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
}): void {
  const openSnippetsRef = useRef(actions.openSnippets)
  openSnippetsRef.current = actions.openSnippets
  const openHelpRef = useRef(actions.openHelp)
  openHelpRef.current = actions.openHelp

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      const mod = e.metaKey || e.ctrlKey
      if (!mod) return

      const state = useStore.getState()
      const { tabs, activeTabId } = state
      const activeTab = tabs.find((t) => t.id === activeTabId)
      const key = e.key.toLowerCase()

      // Cmd/Ctrl+1..9 — jump to the Nth tab
      if (!e.shiftKey && /^[1-9]$/.test(e.key)) {
        const target = tabs[Number(e.key) - 1]
        if (target) {
          e.preventDefault()
          e.stopPropagation()
          state.setActiveTab(target.id)
        }
        return
      }

      switch (key) {
        case 't': {
          // Duplicate the active pane's target into a fresh tab.
          if (!activeTab) return
          const leaf = findLeaf(activeTab.root, activeTab.activePaneId)
          if (!leaf) return
          e.preventDefault()
          e.stopPropagation()
          state.openTab(leaf.title, leaf.target)
          break
        }
        case 'w': {
          if (!activeTab) return
          e.preventDefault()
          e.stopPropagation()
          // Close just the focused pane while the tab is split; otherwise the tab.
          if (activeTab.root.type === 'split') state.closePane(activeTab.id, activeTab.activePaneId)
          else state.closeTab(activeTab.id)
          break
        }
        case 'd': {
          if (!activeTab) return
          e.preventDefault()
          e.stopPropagation()
          state.splitPane(activeTab.id, activeTab.activePaneId, e.shiftKey ? 'col' : 'row')
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

/** Applies the terminal font zoom that the main process intercepted for us. */
export function useZoom(): void {
  useEffect(() => {
    return window.td.ui.onZoom((direction) => {
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
