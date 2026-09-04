import { useEffect, useRef } from 'react'
import { desktopSizeFor, type DesktopSize } from '../../../shared/desktopSize'
import { buttonEvent, PTR, wheelFlags, wheelUnits } from '../../../shared/rdpInput'
import { rdpKeyFor, substituteCommand, unicodeKey } from '../../../shared/rdpScancodes'
import { modifierFixes } from '../../../shared/modifierSync'
import type { ForwardedKey, RdpView } from '../../../shared/types'

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
  /**
   * A stored account to sign in as instead of the host's own login. Named, not
   * resolved: the password stays in the main process either way.
   */
  credentialId?: string
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
  credentialId,
  look,
  password,
  onPhase,
  onMeasured
}: Props): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)
  /**
   * What the far end has been told to hold, so a release that never arrives can
   * be noticed and made good. A ref rather than a local of the keyboard effect
   * because the mouse needs it too — see `syncModifiers`.
   */
  const heldRef = useRef<Set<string>>(new Set())
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  /** The live session, once the main process has given it a name. */
  const idRef = useRef<string | null>(null)
  /** The desktop's own size, as the far end last confirmed it. */
  const sizeRef = useRef<{ width: number; height: number }>({ width: 0, height: 0 })
  /** The last size asked for, so a settled drag does not ask twice. */
  const askedRef = useRef<string>('')
  /** The density last sent with it, which is the other half of the request. */
  const scaleRef = useRef<number>(0)
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
  /* Through a ref like the two above: the session's subscriptions are set up
     once, and a function captured there would go on wording the tooltip with
     whatever the density was when the pane opened. */
  const measuredRef = useRef(measured)
  measuredRef.current = measured

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

  /** One key, as the far end wants it: a scancode and whether it is going down. */
  function sendKey(code: string, down: boolean): boolean {
    const key = rdpKeyFor(code)
    if (!key) return false
    tell({ a: 'key', code: key.code, down, ext: key.extended === true })
    return true
  }

  /**
   * Makes the far end's modifiers agree with this keyboard's, from any event
   * that can be asked about them — a key, or the mouse.
   *
   * The mouse is the half that was missing, and it is the half you notice. A
   * stuck Ctrl was repaired by the next keystroke, which is fine right up until
   * the next thing you do is click: on a desktop that is most of what you do,
   * and every click until you happen to type is a Ctrl-click, selecting instead
   * of opening. `MouseEvent` answers `getModifierState` exactly as a key event
   * does, so the same repair works from there and costs a comparison per move.
   */
  function syncModifiers(
    event: { getModifierState(state: string): boolean },
    options: { ignore?: string | null; press?: boolean } = {}
  ): void {
    const fixes = modifierFixes({
      held: heldRef.current,
      down: (state) => event.getModifierState(state),
      commandAsControl: lookRef.current?.commandAsControl === true,
      ignore: options.ignore,
      press: options.press
    })
    for (const fix of fixes) {
      if (!sendKey(fix.code, fix.down)) continue
      if (fix.down) heldRef.current.add(fix.code)
      else heldRef.current.delete(fix.code)
    }
  }

  /** A forwarded key's modifiers, shaped like the events' own `getModifierState`. */
  function modifierStateOf(key: ForwardedKey): { getModifierState(state: string): boolean } {
    return {
      getModifierState: (state) =>
        state === 'Control'
          ? key.control
          : state === 'Shift'
            ? key.shift
            : state === 'Alt'
              ? key.alt
              : state === 'Meta' && key.meta
    }
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
    const fit = Math.min(rect.width / sizeRef.current.width, rect.height / sizeRef.current.height)

    /**
     * One desktop pixel per device pixel, whenever that is what nearly fits.
     *
     * Any other scale makes the browser resample every frame, and resampling
     * is what "blurry" means. A pane is measured in fractions of a point, so
     * the fit computed from it lands a hair either side of the exact ratio —
     * and the floor this used to apply rounded that hair the wrong way, giving
     * up a sharp picture to be two device pixels narrower than the pane.
     *
     * Snapped only when the two are within a pixel of each other across the
     * whole width, so a genuinely different size is still scaled to fit.
     */
    const oneToOne = 1 / (window.devicePixelRatio || 1)
    const scale = Math.abs(fit - oneToOne) * sizeRef.current.width < 1 ? oneToOne : fit

    // Fractional, deliberately. Rounding to whole CSS pixels is the same
    // mistake in a smaller place.
    canvas.style.width = `${sizeRef.current.width * scale}px`
    canvas.style.height = `${sizeRef.current.height * scale}px`
    // The picture just changed size, so the pointer beside it is now the wrong
    // one. It is the same image; only what it should be divided by moved.
    applyCursor()
  }

  /**
   * What was asked of the far end and what it did, in one line.
   *
   * Both halves, always. Showing only the request was a real gap: a desktop
   * that came back smaller than it was asked for looks exactly like a desktop
   * that was asked for wrongly — the picture is stretched either way — and
   * with only one number there is nothing to tell them apart. The density
   * goes on the end because it is the half of the request that the far end is
   * free to ignore, and ignoring it is what makes a sharp desktop tiny.
   */
  function measured(got?: { width: number; height: number }): string {
    const density = `×${window.devicePixelRatio}`
    const asked = scaleRef.current
      ? `${askedRef.current} at ${scaleRef.current}%`
      : askedRef.current
    /* The budget, because it is the one input that silently changes the answer.
       A pane that grows past it gets a smaller desktop stretched to fill it,
       and from the outside that is indistinguishable from a host refusing the
       size — the difference took two rounds of screenshots to establish, and
       this is the number that would have settled it in one. */
    const budget = lookRef.current?.pixelBudget
    const limit = budget && budget < 50 ? ` · budget ${budget} Mpx` : ''
    return got
      ? `${asked} → ${got.width}×${got.height} · ${density}${limit}`
      : `${asked} · ${density}${limit}`
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
          password,
          credentialId
        })
        if (!alive) {
          void window.td.rdp.desktopStop(id)
          return
        }
        idRef.current = id
        askedRef.current = size ? `${size.width}×${size.height}` : ''
        scaleRef.current =
          size && look?.sendDensity
            ? Math.min(500, Math.max(100, Math.round(size.factor * 100)))
            : 0
        onMeasuredRef.current(size ? measuredRef.current() : '')

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
              // Every delivery, not only the first: a resize is where the two
              // numbers most often stop agreeing.
              onMeasuredRef.current(
                measuredRef.current({
                  width: Number(event.width ?? 0),
                  height: Number(event.height ?? 0)
                })
              )
              if (what === 'connected') {
                onPhaseRef.current({ at: 'connected' })
                // The far end has said what it will actually draw, which is not
                // always what was asked for. Both numbers, so a desktop that
                // came back the wrong size says so rather than merely looking
                // magnified.
                onMeasuredRef.current(
                  measuredRef.current({
                    width: Number(event.width ?? 0),
                    height: Number(event.height ?? 0)
                  })
                )
              }
            } else if (what === 'failed') {
              onPhaseRef.current({
                at: 'failed',
                reason: String(event.detail || 'Could not connect')
              })
            } else if (what === 'closed' || what === 'ended') {
              onPhaseRef.current({
                at: 'closed',
                reason: String(event.detail || 'The session ended')
              })
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
      // Zero leaves the field unstated, which the far end must ignore — so a
      // host that never asked for this is unaffected by it.
      scaleRef.current = lookRef.current?.sendDensity
        ? Math.min(500, Math.max(100, Math.round(size.factor * 100)))
        : 0

      tell({ a: 'resize', width: size.width, height: size.height, scale: scaleRef.current })
      onMeasuredRef.current(measuredRef.current())
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

    /*
     * What is held down lives on a ref, and the repair that keeps it honest is
     * `syncModifiers` in the component body — the mouse handlers need both, and
     * they are not inside this effect.
     */
    const held = heldRef.current

    const onKeyDown = (event: KeyboardEvent): void => {
      if (!container.contains(document.activeElement)) return
      const code = substituteCommand(event.code, lookRef.current?.commandAsControl === true)
      // Every key carries the truth about every modifier, so the one this event
      // is about is left alone and the rest are made to agree.
      syncModifiers(event, { ignore: code })

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
        // The pair above put Ctrl and Alt up over there while the hand is still
        // on both. Saying so keeps the record honest, and the next event presses
        // them again — rather than this end believing they are down and never
        // sending them.
        held.delete('ControlLeft')
        held.delete('AltLeft')
        return
      }
      if (event.altKey && !event.ctrlKey && event.key === 'Home') {
        event.preventDefault()
        event.stopPropagation()
        sendKey('MetaLeft', true)
        sendKey('MetaLeft', false)
        return
      }

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
      /*
       * And again afterwards, because a release can be the thing that puts the
       * two ends out of step rather than the thing that fixes it. With ⌘ acting
       * as Ctrl, letting go of ⌘ while the real Ctrl is still held sends the one
       * Ctrl-up both keys share, and the far end stops holding a key the hand
       * has not left.
       */
      syncModifiers(event, { ignore: code })
    }

    /** Everything still down goes up, because nothing else will report it. */
    const releaseAll = (): void => {
      for (const code of held) sendKey(code, false)
      held.clear()
      tell({ a: 'focus', flags: 0 })
    }

    /**
     * The keys the main process had to take before this window could see them.
     *
     * Two reasons it has to, and both are things this end cannot reach. Chromium
     * zooms the whole interface on Ctrl with `+`, `-` or `0`; and a menu
     * accelerator — ⌘W for Close Window, ⌘R, ⌘Q — is answered before the page
     * is told anything at all. While a session is full screen the main process
     * takes every combination for that reason and hands it back here, where it
     * goes to the far end like any other key.
     *
     * The modifier itself was never taken, so it is already down over there and
     * the pair arrives as the combination it was typed as.
     *
     * Every mounted pane hears this; only the one actually holding the screen
     * acts on it.
     */
    const stopForwarded = window.td.ui.onForwardKey((key) => {
      if (document.fullscreenElement !== fullscreenTarget(container)) return
      /*
       * The modifiers first, from the state this keystroke carried.
       *
       * In full screen this is the only news the session gets about a
       * combination: the letter of every Ctrl-something is taken before the
       * window sees it, so the reconciliation that runs on an ordinary key
       * press never runs on the keys a full-screen desktop is actually made of.
       * That is why a Ctrl left holding over there could sit through a whole
       * session of Ctrl+C and Ctrl+V without anything noticing — and why a Ctrl
       * that had been released too early made those two arrive as a bare
       * letter.
       */
      syncModifiers(modifierStateOf(key), { ignore: key.code })
      sendKey(key.code, true)
      sendKey(key.code, false)
    })

    container.addEventListener('keydown', onKeyDown)
    container.addEventListener('keyup', onKeyUp)
    container.addEventListener('blur', releaseAll, true)
    window.addEventListener('blur', releaseAll)

    return () => {
      stopForwarded()
      container.removeEventListener('keydown', onKeyDown)
      container.removeEventListener('keyup', onKeyUp)
      container.removeEventListener('blur', releaseAll, true)
      window.removeEventListener('blur', releaseAll)
    }
    /* Once. The keyboard is bound to the element, not to any value, and what it
       reads about the host it reads through a ref.

       `sendKey` and `syncModifiers` are declared in the component body and are
       therefore new functions on every render, so listing them would tear the
       listeners down and rebuild them on each one — in the middle of a keystroke,
       between the press and the release. They read the session, the host's
       settings and what is held through refs, so the copies captured here behave
       exactly as this render's would. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      navigator as Navigator & {
        keyboard?: { lock(keys?: string[]): Promise<void>; unlock(): void }
      }
    ).keyboard
    const target = fullscreenTarget(container)

    /**
     * Whether this pane is the one holding the screen.
     *
     * `fullscreenchange` is a document event, so every mounted session hears
     * every one of them — including the ones about somebody else. Without this,
     * two desktops side by side and one of them full screen means the other's
     * handler runs too, decides it is not full screen, and releases the
     * keyboard its neighbour is holding. Which of the two wins comes down to
     * the order they happened to mount in.
     *
     * So each pane answers only for its own transitions.
     */
    let holding = false

    const onChange = (): void => {
      const held = document.fullscreenElement === target
      if (held === holding) return
      holding = held

      if (held) {
        /*
         * Named rather than blanket, so the window cannot swallow keys nobody
         * meant to give it.
         *
         * And said out loud when it does not happen. This is what puts Alt+Tab
         * on the far machine rather than this one, and without it the key is
         * taken by the local system and the session never hears of it — which
         * looks exactly like the session ignoring it. The call can be missing
         * outright, and it can be refused; both were silent, and a whole
         * feature absent with nothing anywhere to say so is how the last three
         * faults today managed to hide.
         */
        const lock = keyboard?.lock([
          'AltLeft',
          'AltRight',
          'Tab',
          'Escape',
          'MetaLeft',
          'MetaRight'
        ])
        if (lock) {
          void lock.catch((err: Error) => {
            console.error(`[desktop] the keyboard could not be captured: ${err.message}`)
          })
        } else {
          console.error('[desktop] no keyboard capture here — Alt+Tab stays with this machine')
        }

        /*
         * And the session takes the keyboard it was just given.
         *
         * Locking without this is the worst of both: the keys are taken from
         * the local system and handed to a session that then drops them,
         * because the handler ignores anything arriving while the focus is
         * outside it. Full screen is entered from the button on the pane's
         * toolbar, which leaves the focus on that button — and the toolbar is
         * not rendered in full screen, so the focus falls to the body and every
         * key goes nowhere at all. Alt+Tab is the one that shows it first,
         * since the lock has just made this the only route it has.
         */
        container.focus()
      } else {
        keyboard?.unlock()
      }
      // And the main process is told, so the keys it claims before this window
      // sees them are handed over rather than acted on here.
      window.td.ui.setKeyboardCapture(held)
    }

    document.addEventListener('fullscreenchange', onChange)
    return () => {
      document.removeEventListener('fullscreenchange', onChange)
      // A pane closed while full screen leaves nothing behind to say so, and a
      // claim left standing would go on taking keys for a session that is gone.
      if (holding) {
        keyboard?.unlock()
        window.td.ui.setKeyboardCapture(false)
      }
    }
  }, [])

  /* --------------------------------------------------------------- the mouse */

  const onMouse = (event: React.MouseEvent, down: boolean | null): void => {
    const at = pointOf(event)
    if (!at) return
    /*
     * The mouse says what the modifiers are doing as readily as a key does, and
     * it is the one that gets asked on a desktop: a Ctrl left holding over there
     * turns every click into a Ctrl-click, and until this the repair only ever
     * came from the next keystroke — which, while you are clicking, does not
     * come at all.
     */
    syncModifiers(event)

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
        // A wheel turn is an ordinary pointer event with the rotation folded
        // into its flags; see wheelFlags, which is where the folding is stated
        // and tested. Both axes, because a trackpad turns both at once.
        const turns = [
          wheelFlags(wheelUnits(e.deltaY, e.deltaMode)),
          wheelFlags(wheelUnits(e.deltaX, e.deltaMode), true)
        ]
        for (const flags of turns) {
          if (flags !== null) tell({ a: 'mouse', flags, x: at.x, y: at.y })
        }
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
 * where it leaves entirely rather than leaving a strip that would swallow
 * clicks meant for the desktop, so the
 * desktop is asked for the size of the display itself.
 */
export function fullscreenTarget(container: Element): Element {
  return container.closest('.pane') ?? container
}

export function toggleFullscreen(target: Element): void {
  if (document.fullscreenElement === target) void document.exitFullscreen()
  else void target.requestFullscreen()
}
