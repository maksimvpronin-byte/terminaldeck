import { useEffect } from 'react'
import { useStore, type PaneNode } from '../state/store'

const IDLE_LOCK_MS = 15 * 60 * 1000

/**
 * Window-level shortcuts. Registered in the capture phase so they win over
 * xterm.js, which otherwise swallows the keystroke into the remote shell.
 */
export function useShortcuts(): void {
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
          if (!activeTabId) return
          e.preventDefault()
          e.stopPropagation()
          state.closeTab(activeTabId)
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
        default:
          break
      }
    }

    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
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
