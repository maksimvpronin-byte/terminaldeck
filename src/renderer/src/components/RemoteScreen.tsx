import { useEffect, useRef } from 'react'
import { desktopSizeFor, type DesktopSize } from '../../../shared/desktopSize'
import { buttonEvent, PTR, wheelUnits } from '../../../shared/rdpInput'
import { rdpKeyFor, substituteCommand, unicodeKey } from '../../../shared/rdpScancodes'
import type { RdpView } from '../../../shared/types'

/**
 * A desktop, drawn from the pixels a client in another process decoded.
 *
 * There is no library under this and nothing embedded in the page: the far
 * end's screen arrives as rectangles of RGBA and goes onto a canvas, and the
 * keyboard and mouse go back the other way. What that buys is the reason the
 * client was replaced at all — FreeRDP negotiates the graphics pipeline, so a
 * host that offers H.264 or progressive RemoteFX is decoded as such instead of
 * being sent as run-length-encoded bitmaps.
 *
 * The session belongs to this component. It starts one when it mounts and ends
 * it when it unmounts, so a retry is a remount and there is no state machine
 * here that could disagree with the one in the main process.
 */

export type ScreenPhase =
  | { at: 'connecting' }
  | { at: 'connected' }
  | { at: 'failed'; reason: string }
  | { at: 'closed'; reason: string }

/** The far end's pointer, in its own pixels. */
interface PointerImage {
  width: number
  height: number
  hotX: number
  hotY: number
  pixels: Uint8Array
}

interface Props {
  /** The saved host. Where it is reached, and as whom, is settled in main. */
  sessionId: string
  look: RdpView | null
  /** Typed in the pane, for a host with nothing saved. */
  password?: string
  onPhase: (phase: ScreenPhase) => void
  /**
   * What was asked for and what came back, for the pane's tooltip.
   *
   * Whether a desktop is drawn at the screen's pixels or the pane's points is
   * the difference between a sharp picture and a magnified one, and from the
   * outside the two are told apart only by squinting.
   */
  onMeasured: (text: string) => void
}

/** How long to let a drag settle before asking the far end to resize. */
const RESIZE_SETTLE = 250

/**
 * The bytes that arrived, in the form `ImageData` takes, without copying them.
 *
 * Two things are going on in one line. The obvious one: `new
 * Uint8ClampedArray(someUint8Array)` copies, and at 2560×1440 that is fifteen
 * megabytes a frame spent on nothing — these bytes are already RGBA in reading
 * order, which is exactly what ImageData is, so a view over them will do.
 *
 * The cast is the second. A typed array's `buffer` is declared as
 * `ArrayBufferLike`, which includes `SharedArrayBuffer`, and `ImageData` will
 * not take one of those. Nothing here can be shared: this arrived over IPC,
 * which has no way to deliver shared memory, and structured cloning produces a
 * plain buffer every time.
 *
 * The parameter on the return type is not decoration. Written bare,
 * `Uint8ClampedArray` means `Uint8ClampedArray<ArrayBufferLike>`, which throws
 * away the very narrowing the cast below performs.
 */
function asPixels(bytes: Uint8Array): Uint8ClampedArray<ArrayBuffer> {
  return new Uint8ClampedArray(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength)
}

export default function RemoteScreen({
  sessionId,
  look,
  password,
  onPhase,
  onMeasured
}: Props): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  /** The live session, once the main process has given it a name. */
  const idRef = useRef<string | null>(null)
  /** The desktop's own size, as the far end last confirmed it. */
  const sizeRef = useRef<{ width: number; height: number }>({ width: 0, height: 0 })
  /** The last size asked for, so a settled drag does not ask twice. */
  const askedRef = useRef<string>('')
  /**
   * The pointer the far end last sent, kept rather than used and dropped.
   *
   * How large to draw it depends on how large the picture is being drawn, and
   * that changes with every resize — while the pointer itself may not change
   * for minutes. Keeping it is what lets the two be recomputed together.
   */
  const cursorRef = useRef<PointerImage | null>(null)
  /** Held so the effect below can be written once and read the current values. */
  const lookRef = useRef(look)
  lookRef.current = look
  const onPhaseRef = useRef(onPhase)
  onPhaseRef.current = onPhase
  const onMeasuredRef = useRef(onMeasured)
  onMeasuredRef.current = onMeasured

  /**
   * How big the desktop should be, in the far end's own pixels.
   *
   * The arithmetic — the density, the magnification, the host's pixel budget
   * and what [MS-RDPEDISP] will accept — lives in shared/desktopSize.ts, where
   * it is tested. What is left here is the two things it cannot know: how large
   * the pane is at this moment, and how dense the display it is on happens to
   * be.
   */
  function desired(): DesktopSize | null {
    const rect = containerRef.current?.getBoundingClientRect()
    return desktopSizeFor(lookRef.current, rect ?? null, window.devicePixelRatio)
  }

  /** Says a thing to the running session, or nothing if there is not one. */
  function tell(fields: Record<string, string | number | boolean | undefined>): void {
    const id = idRef.current
    if (id) window.td.rdp.desktopSend(id, fields)
  }

  /**
   * Fits the canvas into the pane without distorting it.
   *
   * The canvas holds the desktop's own pixels; how large it is *drawn* is a
   * separate question, and the two are equal only where the pane and the
   * desktop happen to match. Letting CSS stretch it to the pane would squash
   * the picture whenever they do not — which is every moment between a drag
   * ending and the far end answering.
   */
  function layOut(): void {
    const canvas = canvasRef.current
    const container = containerRef.current
    if (!canvas || !container || !sizeRef.current.width) return

    const rect = container.getBoundingClientRect()
    const scale = Math.min(
      rect.width / sizeRef.current.width,
      rect.height / sizeRef.current.height
    )
    canvas.style.width = `${Math.floor(sizeRef.current.width * scale)}px`
    canvas.style.height = `${Math.floor(sizeRef.current.height * scale)}px`
    // The picture just changed size, so the pointer beside it is now the wrong
    // one. It is the same image; only what it should be divided by moved.
    applyCursor()
  }

  /**
   * How many of the desktop's pixels go into one of this page's.
   *
   * Two on a Retina display showing a desktop asked for in the screen's own
   * pixels; one where the pane and the desktop match. Everything that has to
   * cross between the two coordinate systems goes through this.
   */
  function density(): number {
    const canvas = canvasRef.current
    if (!canvas || !canvas.width) return 1
    const rect = canvas.getBoundingClientRect()
    return rect.width > 0 ? canvas.width / rect.width : 1
  }

  /**
   * Puts the far end's pointer on the pane, at the size the picture is drawn.
   *
   * A cursor image is measured by CSS in this page's pixels, and the far end
   * sends it in its own — so a 32-pixel arrow beside a desktop drawn at two
   * device pixels per point comes out twice the size of every other cursor on
   * the screen. It has to be divided by the same number the picture is.
   *
   * `image-set` is the way to say that without throwing away the resolution:
   * it hands the browser the image at its native size and tells it what
   * density that size is for, so a sharp display draws a sharp cursor. Where
   * it is not understood the declaration is dropped whole — which leaves the
   * previous cursor in place rather than a wrong one — so it is checked, and
   * a resampled image is used instead.
   */
  function applyCursor(): void {
    const container = containerRef.current
    const image = cursorRef.current
    if (!container || !image) return

    const scale = density()
    const scratch = document.createElement('canvas')
    scratch.width = image.width
    scratch.height = image.height
    const paint = scratch.getContext('2d')
    if (!paint) return
    paint.putImageData(new ImageData(asPixels(image.pixels), image.width, image.height), 0, 0)

    // In this page's pixels, because that is what CSS measures a hotspot in.
    const hotX = Math.round(image.hotX / scale)
    const hotY = Math.round(image.hotY / scale)

    try {
      const native = scratch.toDataURL()
      /* Cleared first, or the test below is not a test: a rejected declaration
         leaves the property at its previous value, and the previous value is
         the cursor set a moment ago — which reads as success. */
      container.style.cursor = ''
      container.style.cursor = `image-set(url(${native}) ${scale}x) ${hotX} ${hotY}, default`
      if (container.style.cursor) return

      // Not understood. Resampled to the size it should occupy, which is
      // softer on a dense display and the right size everywhere.
      const fitted = document.createElement('canvas')
      fitted.width = Math.max(1, Math.round(image.width / scale))
      fitted.height = Math.max(1, Math.round(image.height / scale))
      const draw = fitted.getContext('2d')
      if (!draw) return
      draw.drawImage(scratch, 0, 0, fitted.width, fitted.height)
      container.style.cursor = `url(${fitted.toDataURL()}) ${hotX} ${hotY}, default`
    } catch {
      // A browser that refuses the image — an oversized cursor, mostly.
      container.style.cursor = 'default'
    }
  }

  /** Where a mouse event lands, in the desktop's own pixels. */
  function pointOf(event: React.MouseEvent | MouseEvent): { x: number; y: number } | null {
    const canvas = canvasRef.current
    if (!canvas || !canvas.width) return null
    const rect = canvas.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return null
    const x = Math.round((event.clientX - rect.left) * (canvas.width / rect.width))
    const y = Math.round((event.clientY - rect.top) * (canvas.height / rect.height))
    return {
      x: Math.max(0, Math.min(canvas.width - 1, x)),
      y: Math.max(0, Math.min(canvas.height - 1, y))
    }
  }

  /* ------------------------------------------------------------ the session */

  useEffect(() => {
    let alive = true
    let stopSubscriptions: Array<() => void> = []
    /** Set once a frame has been drawn and is waiting to be acknowledged. */
    let acking = 0

    const canvas = canvasRef.current
    const context = canvas?.getContext('2d', { alpha: false }) ?? null

    /**
     * Puts one rectangle on the canvas and says so, a frame later.
     *
     * The acknowledgement is what lets the far end send the next one — see the
     * shim, where at most one frame is ever in flight. Sending it from a
     * repaint rather than immediately paces the session to this display: there
     * is no value in decoding frames faster than they can be shown, and a great
     * deal of cost.
     */
    const draw = (frame: {
      x: number
      y: number
      width: number
      height: number
      pixels: Uint8Array
    }): void => {
      if (!context) return
      const view = asPixels(frame.pixels)
      try {
        context.putImageData(new ImageData(view, frame.width, frame.height), frame.x, frame.y)
      } catch {
        // A frame that arrived after the canvas was resized under it. The next
        // one repairs the screen; refusing to acknowledge would stall it.
      }
      if (acking) return
      acking = window.requestAnimationFrame(() => {
        acking = 0
        tell({ a: 'ack' })
      })
    }

    const resize = (width: number, height: number): void => {
      sizeRef.current = { width, height }
      const canvas = canvasRef.current
      if (canvas && (canvas.width !== width || canvas.height !== height)) {
        // Setting either clears the canvas; the client sends the whole screen
        // straight after a size change, so nothing is lost.
        canvas.width = width
        canvas.height = height
      }
      layOut()
    }

    void (async () => {
      const size = desired()
      try {
        const id = await window.td.rdp.desktopStart({
          sessionId,
          width: size?.width ?? 1280,
          height: size?.height ?? 800,
          scale: size ? Math.min(500, Math.max(100, Math.round(size.factor * 100))) : undefined,
          password
        })
        if (!alive) {
          void window.td.rdp.desktopStop(id)
          return
        }
        idRef.current = id
        askedRef.current = size ? `${size.width}×${size.height}` : ''
        onMeasuredRef.current(
          size ? `${size.width}×${size.height} · ×${window.devicePixelRatio}` : ''
        )

        stopSubscriptions = [
          window.td.rdp.onDesktopFrame(id, draw),
          window.td.rdp.onDesktopCursor(id, (cursor) => {
            const container = containerRef.current
            if (!container) return
            if ('kind' in cursor) {
              cursorRef.current = null
              container.style.cursor = cursor.kind === 'hidden' ? 'none' : 'default'
            } else {
              cursorRef.current = cursor
              applyCursor()
            }
          }),
          window.td.rdp.onDesktopEvent(id, (event) => {
            const what = String(event.e ?? '')
            if (what === 'connected' || what === 'size') {
              resize(Number(event.width ?? 0), Number(event.height ?? 0))
              if (what === 'connected') {
                onPhaseRef.current({ at: 'connected' })
                // The far end has said what it will actually draw, which is not
                // always what was asked for. Both numbers, so a desktop that
                // came back the wrong size says so rather than merely looking
                // magnified.
                onMeasuredRef.current(
                  `${askedRef.current} → ${event.width}×${event.height} · ×${window.devicePixelRatio}`
                )
              }
            } else if (what === 'failed') {
              onPhaseRef.current({ at: 'failed', reason: String(event.detail || 'Could not connect') })
            } else if (what === 'closed' || what === 'ended') {
              onPhaseRef.current({ at: 'closed', reason: String(event.detail || 'The session ended') })
            } else if (what === 'logon') {
              // The host's own explanation, which is usually the real one.
              onPhaseRef.current({ at: 'failed', reason: String(event.detail ?? '') })
            }
          })
        ]
      } catch (err) {
        if (alive) {
          onPhaseRef.current({
            at: 'failed',
            reason: err instanceof Error ? err.message : String(err)
          })
        }
      }
    })()

    return () => {
      alive = false
      if (acking) window.cancelAnimationFrame(acking)
      for (const stop of stopSubscriptions) stop()
      const id = idRef.current
      idRef.current = null
      if (id) void window.td.rdp.desktopStop(id)
    }
    // Deliberately once: a change of host or password is a different session,
    // and the pane remounts this component for one. Everything reactive that
    // the callbacks read is held in a ref above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* ------------------------------------------------------------- the resize */

  /**
   * Makes the desktop the size of the pane, rather than scaling one into it.
   *
   * Asking the far end to change resolution keeps every pixel its own, which is
   * what a desktop client does when its window is dragged. A host pinned to a
   * fixed size keeps it and the picture is fitted instead — which is the point
   * of asking for a fixed one.
   */
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    let pending: number | undefined
    const send = (): void => {
      layOut()
      if (lookRef.current?.resolution === 'fixed') return
      const size = desired()
      if (!size) return
      const stated = `${size.width}×${size.height}`
      if (stated === askedRef.current) return
      askedRef.current = stated

      tell({
        a: 'resize',
        width: size.width,
        height: size.height,
        // Zero leaves the field unstated, which the far end must ignore — so a
        // host that never asked for this is unaffected by it.
        scale: lookRef.current?.sendDensity
          ? Math.min(500, Math.max(100, Math.round(size.factor * 100)))
          : 0
      })
      onMeasuredRef.current(`${stated} · ×${window.devicePixelRatio}`)
    }

    const observer = new ResizeObserver(() => {
      // Dragging a split fires this every frame, and each one is a round trip
      // and a full redraw. The far end only needs the size the drag ended on.
      window.clearTimeout(pending)
      pending = window.setTimeout(send, RESIZE_SETTLE)
    })
    observer.observe(container)

    /**
     * Dragging the window to a screen of a different density changes how many
     * pixels the pane is worth without changing how many points it measures, so
     * the observer above says nothing. Left alone, the desktop keeps the size
     * the old screen asked for: too few pixels on the way to a sharper display,
     * too many on the way back.
     */
    let density: MediaQueryList | null = null
    const onDensity = (): void => {
      watch()
      send()
    }
    const watch = (): void => {
      density?.removeEventListener('change', onDensity)
      density = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
      density.addEventListener('change', onDensity)
    }
    watch()

    return () => {
      observer.disconnect()
      density?.removeEventListener('change', onDensity)
      window.clearTimeout(pending)
    }
    /* Every field of `look` that changes what size to ask for, and nothing
       else. Listing `look` itself would rebuild the observer and the density
       watch on each render; listing fewer of these is how a pinned session
       once went on asking for the size it was opened with.

       `layOut`, `desired` and `tell` are declared in the component body, so
       they are new objects on every render and listing them would tear the
       observer down on each one. Everything reactive they read is either on
       this list or behind a ref. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    look?.resolution,
    look?.desktopWidth,
    look?.desktopHeight,
    look?.pixelBudget,
    look?.magnification,
    look?.sendDensity
  ])

  /* ----------------------------------------------------------- the keyboard */

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    /**
     * What is held down, so it can be released if the focus leaves.
     *
     * A modifier whose key-up never arrived is held over there indefinitely,
     * and every subsequent letter is a shortcut. That happens whenever a key is
     * still down as the window loses focus — ⌘Tab, most often.
     */
    const held = new Set<string>()

    const sendKey = (code: string, down: boolean): boolean => {
      const key = rdpKeyFor(code)
      if (!key) return false
      tell({
        a: 'key',
        code: key.code,
        down,
        ext: key.extended === true
      })
      return true
    }

    const onKeyDown = (event: KeyboardEvent): void => {
      if (!container.contains(document.activeElement)) return

      // Full screen belongs to the pane, and the toolbar button means the same
      // thing; see `.pane:fullscreen` in styles.css.
      if (event.key === 'F11') {
        event.preventDefault()
        event.stopPropagation()
        toggleFullscreen(fullscreenTarget(container))
        return
      }

      /**
       * The stand-ins for the keys this machine keeps for itself.
       *
       * Windows takes Ctrl+Alt+Del in the kernel — that is the point of it —
       * so every client offers a substitute on keys the local system does let
       * through. These are the ones they all use. Sent as the three real keys
       * rather than as a message of its own, because that is what the far end
       * is waiting for.
       */
      if (event.altKey && event.ctrlKey && event.key === 'End') {
        event.preventDefault()
        event.stopPropagation()
        for (const code of ['ControlLeft', 'AltLeft', 'Delete']) sendKey(code, true)
        for (const code of ['Delete', 'AltLeft', 'ControlLeft']) sendKey(code, false)
        return
      }
      if (event.altKey && !event.ctrlKey && event.key === 'Home') {
        event.preventDefault()
        event.stopPropagation()
        sendKey('MetaLeft', true)
        sendKey('MetaLeft', false)
        return
      }

      const code = substituteCommand(event.code, lookRef.current?.commandAsControl === true)
      event.preventDefault()
      event.stopPropagation()

      if (sendKey(code, true)) {
        held.add(code)
        return
      }
      /**
       * A character no key on this keyboard produces on its own — anything
       * composed, or typed through an input method. There is no scancode for
       * it, and RDP has a second path for exactly this case.
       */
      const unit = unicodeKey(event.key)
      if (unit !== undefined) {
        tell({ a: 'unicode', code: unit, down: true })
        tell({ a: 'unicode', code: unit, down: false })
      }
    }

    const onKeyUp = (event: KeyboardEvent): void => {
      if (!container.contains(document.activeElement)) return
      const code = substituteCommand(event.code, lookRef.current?.commandAsControl === true)
      event.preventDefault()
      event.stopPropagation()
      held.delete(code)
      sendKey(code, false)
    }

    /** Everything still down goes up, because nothing else will report it. */
    const releaseAll = (): void => {
      for (const code of held) sendKey(code, false)
      held.clear()
      tell({ a: 'focus', flags: 0 })
    }

    container.addEventListener('keydown', onKeyDown)
    container.addEventListener('keyup', onKeyUp)
    container.addEventListener('blur', releaseAll, true)
    window.addEventListener('blur', releaseAll)

    return () => {
      container.removeEventListener('keydown', onKeyDown)
      container.removeEventListener('keyup', onKeyUp)
      container.removeEventListener('blur', releaseAll, true)
      window.removeEventListener('blur', releaseAll)
    }
    // Once. The keyboard is bound to the element, not to any value, and what it
    // reads about the host it reads through a ref.
  }, [])

  /**
   * Full screen, with the system keys along with it.
   *
   * This is the only way Alt+Tab can ever reach the far side. The shell takes
   * it before any program sees it, and the one documented exception is a page
   * that is full screen and has asked to hold the keyboard. Held, the key
   * arrives as an ordinary keystroke and is forwarded like any other.
   */
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const keyboard = (
      navigator as Navigator & { keyboard?: { lock(keys?: string[]): Promise<void>; unlock(): void } }
    ).keyboard
    const target = fullscreenTarget(container)

    const onChange = (): void => {
      if (document.fullscreenElement === target) {
        // Named rather than blanket, so the window cannot swallow keys nobody
        // meant to give it.
        void keyboard?.lock(['AltLeft', 'AltRight', 'Tab', 'Escape', 'MetaLeft', 'MetaRight'])
      } else {
        keyboard?.unlock()
      }
    }

    document.addEventListener('fullscreenchange', onChange)
    return () => {
      document.removeEventListener('fullscreenchange', onChange)
      keyboard?.unlock()
    }
  }, [])

  /* --------------------------------------------------------------- the mouse */

  const onMouse = (event: React.MouseEvent, down: boolean | null): void => {
    const at = pointOf(event)
    if (!at) return

    if (down === null) {
      tell({ a: 'mouse', flags: PTR.move, x: at.x, y: at.y })
      return
    }
    const button = buttonEvent(event.button, down)
    if (!button) return
    event.preventDefault()
    tell({
      a: button.extended ? 'xmouse' : 'mouse',
      flags: button.flags,
      x: at.x,
      y: at.y
    })
  }

  return (
    <div
      className="graphical-screen"
      ref={containerRef}
      // So the keyboard can reach it at all: a div is not focusable otherwise,
      // and every key would go to whatever was focused before the pane opened.
      tabIndex={0}
      onMouseDown={(e) => {
        containerRef.current?.focus()
        onMouse(e, true)
      }}
      onMouseUp={(e) => onMouse(e, false)}
      onMouseMove={(e) => onMouse(e, null)}
      onFocus={() => tell({ a: 'focus', flags: 0 })}
      // The far side's own menu, not this machine's.
      onContextMenu={(e) => e.preventDefault()}
      onWheel={(e) => {
        const at = pointOf(e)
        if (!at) return
        const vertical = wheelUnits(e.deltaY, e.deltaMode)
        const horizontal = wheelUnits(e.deltaX, e.deltaMode)
        if (vertical) tell({ a: 'wheel', delta: vertical, x: at.x, y: at.y })
        if (horizontal) tell({ a: 'wheel', delta: horizontal, horizontal: true, x: at.x, y: at.y })
      }}
    >
      <canvas ref={canvasRef} className="graphical-canvas" />
    </div>
  )
}

/**
 * What goes full screen: the pane, not the picture inside it.
 *
 * So the button there and F11 here mean the same thing, rather than each
 * claiming the screen for a different element. The toolbar comes along but
 * stops taking a strip of the screen — see `.pane:fullscreen` in styles.css,
 * where it slides out of the way and comes back for a pointer that rests there
 * rather than one that passes, so the
 * desktop is asked for the size of the display itself.
 */
export function fullscreenTarget(container: Element): Element {
  return container.closest('.pane') ?? container
}

export function toggleFullscreen(target: Element): void {
  if (document.fullscreenElement === target) void document.exitFullscreen()
  else void target.requestFullscreen()
}
