import { useEffect, type RefObject } from 'react'

/**
 * Sends ⌘ to a desktop as Ctrl.
 *
 * Windows puts copy, paste and nearly everything else on Ctrl, and a Mac
 * keyboard puts the same muscle memory on ⌘ — which RDP faithfully delivers as
 * the Windows key, opening the Start menu instead of copying. Nothing in the
 * client can be told to map one to the other: it turns `KeyboardEvent.code`
 * into a scancode through a fixed table, so the substitution has to happen
 * before the event reaches it.
 *
 * The client listens on `window` in the bubble phase, so a capture-phase
 * listener on `window` sees every key first. Stopping propagation there keeps
 * the original from ever reaching the client, and a synthetic event dispatched
 * in its place arrives instead.
 *
 * Two things this deliberately does not do. It leaves ⌘ alone unless the
 * desktop has the focus, so the app's own shortcuts keep working everywhere
 * else. And it cannot see ⌘Q or ⌘Tab at all — the menu accelerator and the
 * window manager take those long before the page does, which is the right
 * outcome for both.
 */
export function useCommandAsControl(
  container: RefObject<HTMLElement | null>,
  active: boolean
): void {
  useEffect(() => {
    if (!active) return
    const element = container.current
    if (!element) return

    /**
     * Events this hook made, which must pass through untouched. A WeakSet
     * rather than a property, so nothing is added to an object the client also
     * reads, and so the entries go when the events do.
     */
    const ours = new WeakSet<KeyboardEvent>()

    const translate = (event: KeyboardEvent): void => {
      if (ours.has(event)) return
      // Somewhere else in the app has the keyboard: leave its shortcuts alone.
      if (!element.contains(document.activeElement)) return
      if (!event.metaKey && event.code !== 'MetaLeft' && event.code !== 'MetaRight') return

      event.preventDefault()
      event.stopImmediatePropagation()

      const code =
        event.code === 'MetaLeft'
          ? 'ControlLeft'
          : event.code === 'MetaRight'
            ? 'ControlRight'
            : event.code

      send(event.type, code, event.target)

      /**
       * macOS stops delivering key releases while ⌘ is held, so a key pressed
       * in a ⌘ combination never reports going up and the far end holds it
       * down forever — the next keystroke arrives as part of a combination
       * nobody typed. Releasing it here is the only place that can be known.
       */
      if (event.type === 'keydown' && code !== 'ControlLeft' && code !== 'ControlRight') {
        send('keyup', code, event.target)
      }
    }

    const send = (type: string, code: string, target: EventTarget | null): void => {
      const synthetic = new KeyboardEvent(type, {
        code,
        key: code.startsWith('Control') ? 'Control' : '',
        bubbles: true,
        cancelable: true,
        composed: true
      })
      ours.add(synthetic)
      ;(target ?? element).dispatchEvent(synthetic)
    }

    window.addEventListener('keydown', translate, true)
    window.addEventListener('keyup', translate, true)
    return () => {
      window.removeEventListener('keydown', translate, true)
      window.removeEventListener('keyup', translate, true)
    }
  }, [container, active])
}
