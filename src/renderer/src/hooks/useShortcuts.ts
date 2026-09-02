import { useEffect, useRef } from 'react'
import { useStore, activeTab, activeWorkspace, type PaneNode } from '../state/store'
import { findHost, type FoundHost } from '../state/hosts'
import { DEFAULT_SETTINGS } from '../state/settings'
import { IS_MAC } from '../state/keys'

function clampFontSize(size: number): number {
  return Math.min(32, Math.max(8, size))
}

/**
 * Whether a remote desktop is full screen, and so owns every key on the board.
 *
 * Asked of the DOM rather than kept as state, because the DOM is where the
 * answer already is and a flag would be one more thing to leave stale when a
 * pane closes with the screen still held.
 *
 * `fullscreenTarget` puts the *pane* full screen rather than the picture inside
 * it, so what is asked is whether the full-screen element contains a session's
 * canvas. A terminal has no way to get here — the button is only drawn for a
 * desktop, and F11 is only handled by one.
 */
function desktopHoldsKeyboard(): boolean {
  const full = document.fullscreenElement
  return full !== null && full.querySelector('.graphical-screen') !== null
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
      /**
       * ⌘ on a Mac, and only ⌘.
       *
       * This used to accept Ctrl as well, which meant every shortcut below was
       * also bound to a key the shell needs: Ctrl+D ends a session, Ctrl+K
       * kills to the end of the line, Ctrl+W deletes a word, Ctrl+L clears the
       * screen, Ctrl+P walks back through history. All of them were being
       * caught here and turned into split, snippets, lock and so on, and the
       * keystroke never reached the far end.
       */
      const mod = IS_MAC ? e.metaKey : e.ctrlKey
      if (!mod) return

      /**
       * A full-screen desktop takes the whole keyboard, this app included.
       *
       * The capture phase is what makes this necessary rather than merely
       * tidy. These handlers run before the session's own, so every shortcut
       * below was being taken out of a full-screen desktop — Ctrl+W closed the
       * tab the desktop was in instead of closing a window on the far machine,
       * which is a keystroke aimed at one computer landing on another.
       *
       * Nothing is reserved, deliberately: an exception list is how the
       * surprise comes back. The two ways out do not pass through here — F11
       * is handled by the session itself before it forwards anything, and
       * holding Escape is the browser's own release of the locked keyboard.
       *
       * Checked after the modifier, not before: this reads the DOM, and a
       * session being typed into sends far more unmodified keys than modified
       * ones.
       */
      if (desktopHoldsKeyboard()) return

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

/**
 * Locks the vault after a stretch of no keyboard or pointer activity.
 *
 * How long is a setting, because the right answer is a property of the room
 * rather than of the application: fifteen minutes is impatient for someone
 * reading a build log on a machine nobody else can reach, and generous for a
 * laptop on a desk in an open office. Zero turns it off, which is a decision
 * someone is entitled to make and is stated in the dialog as such.
 */
export function useIdleLock(): void {
  const minutes = useStore((s) => s.settings.lockAfterMinutes)

  useEffect(() => {
    if (!minutes || minutes <= 0) return
    let timer: ReturnType<typeof setTimeout>

    function reset(): void {
      clearTimeout(timer)
      timer = setTimeout(
        () => {
          if (!useStore.getState().vaultLocked) useStore.getState().lockVault()
        },
        minutes * 60 * 1000
      )
    }

    // Captured, so activity inside a terminal counts: xterm stops these from
    // bubbling, and a session someone is typing into is not an idle one.
    const events: Array<keyof WindowEventMap> = ['keydown', 'mousemove', 'mousedown', 'wheel']
    for (const evt of events) window.addEventListener(evt, reset, true)
    reset()

    return () => {
      clearTimeout(timer)
      for (const evt of events) window.removeEventListener(evt, reset, true)
    }
  }, [minutes])
}

type LeafNode = Extract<PaneNode, { type: 'leaf' }>

function findLeaf(node: PaneNode, id: string): LeafNode | undefined {
  if (node.type === 'leaf') return node.id === id ? node : undefined
  return findLeaf(node.children[0], id) ?? findLeaf(node.children[1], id)
}
