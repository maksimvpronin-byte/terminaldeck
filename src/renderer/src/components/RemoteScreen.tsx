import { useEffect, useRef, useState } from 'react'
import { useT, type Translate } from '../i18n'
import { desktopSizeFor, type DesktopSize } from '../../../shared/desktopSize'
import { buttonEvent, PTR, wheelFlags, wheelTurns } from '../../../shared/rdpInput'
import { rdpKeyFor, substituteCommand, textKey, unicodeKey } from '../../../shared/rdpScancodes'
import { modifierFixes } from '../../../shared/modifierSync'
import { isLockKey, lockFlags } from '../../../shared/lockSync'
import { IS_MAC } from '../state/keys'
import type { ForwardedKey, RdpView } from '../../../shared/types'
import { isRefusal } from '../../../shared/rdpLogon'
import { endedBySignOut } from '../../../shared/rdpLogoff'
import { diag, diagKey } from '../diag'
import { describeModifiers } from '../../../shared/diagnostics'

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
  visible: boolean
  /** The pane in front of its tab. */
  active?: boolean
  /**
   * Bumped when a host or tab is clicked, to hand the keyboard to the active
   * pane — see `focusActivePane`. Becoming active alone is not enough: a tab
   * reached with ⌘1…9 has to leave the keyboard where it was, or the next ⌘2
   * would go to the far end with everything else a focused desktop takes.
   */
  focusRequest?: number
  /** The saved host. Where it is reached, and as whom, is settled in main. */
  sessionId?: string
  /**
   * Or a desktop typed into Quick connect, which has no saved host behind it:
   * where it is and who to sign in as, and nothing else.
   */
  quick?: { host: string; port: number; username: string }
  /**
   * A stored account to sign in as instead of the host's own login. Named, not
   * resolved: the password stays in the main process either way.
   */
  credentialId?: string
  /** The administrative session for this connection, whatever the host says. */
  admin?: boolean
  look: RdpView | null
  /** Typed in the pane, for a host with nothing saved. */
  password?: string
  onPhase: (phase: ScreenPhase) => void
  /** The live session, and undefined once it has ended — the tree marks the
   *  host as open on the strength of it. */
  onSession?: (id: string | undefined) => void
  /**
   * What was asked for and what came back, for the pane's tooltip.
   *
   * Whether a desktop is drawn at the screen's pixels or the pane's points is
   * the difference between a sharp picture and a magnified one, and from the
   * outside the two are told apart only by squinting.
   */
  onMeasured: (text: string) => void
  /**
   * Something the host said that is worth repeating but is not a refusal - see
   * `isRefusal`. It arrives while the pane is still connecting, so it belongs
   * beside the progress rather than in place of it.
   */
  onNotice: (text: string) => void
  /**
   * The Windows session was signed out of — from inside it, or logged off from
   * elsewhere. Said instead of a closed phase: there is no session left to show
   * "Session ended" over, and the pane goes. See `endedBySignOut`.
   */
  onSignedOut?: () => void
  /**
   * The language letters are typed in right now — this Mac's, since they go
   * over as its characters — or null when that is not what decides them: keys
   * sent as keys, or no Mac language to read. For the pane to show, because in
   * full screen the menu bar that says it is gone and the far taskbar, the one
   * indicator left on screen, is only ever a guess. See `alignLanguage`.
   */
  onTypingLanguage?: (language: string | null) => void
  /**
   * Raised by the pane when its language mark is clicked: the far side shows
   * the other language, so Alt+Shift is pressed there once and this end
   * believes the two agree again.
   */
  layoutFix?: number
}

/** How long to let a drag settle before asking the far end to resize. */
const RESIZE_SETTLE = 250

/**
 * Between the presses of the Alt+Shift that keeps the far layout in step:
 * enough for the far side to see four events rather than a burst, and short
 * enough that what is typed meanwhile, held back until it is done, is not
 * noticeably late.
 */
const LANGUAGE_KEY_GAP = 15

/**
 * How long the keys have to be still before the far layout is matched: longer
 * than the gap between two keys of one word, short enough that the taskbar
 * has caught up by the time anyone looks at it. See `alignLanguage`.
 */
const LANGUAGE_IDLE = 600

/** How long the language shown over the desktop stays before it fades. */
const LANGUAGE_HUD = 900

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
/**
 * Why a file copy failed, and which path it was about.
 *
 * Two lines, because only the first is a phrase-book key: it has to match to
 * the character to be translated at all, and a path never translates. The
 * client sends the path because the four things that can go wrong here are all
 * properties of one — a share, a name Windows will not have, a file that has
 * gone — and none of them is guessable from the sentence alone.
 */
function explainFailure(t: Translate, text: string): string {
  const [reason, where] = text.split('\n')
  return where ? `${t(reason)} — ${where}` : t(reason)
}

/**
 * How long after a change of the Mac's language each keystroke is described in
 * the log. Letters typed straight after fn were arriving in a mix of the two
 * layouts, and this is what tells a stale character from this side apart from
 * one the far side's layout made of a key.
 */
const LANGUAGE_WATCH = 1500

/**
 * Which alphabet a keystroke's character is in, for that log line. Never the
 * character itself, and never which key: together those would be the text.
 */
function scriptOf(key: string): string {
  if (key.length !== 1)
    return `no character (${key === 'Dead' || key === 'Process' || key === 'Unidentified' ? key : 'a named key'})`
  if (/[A-Za-z]/.test(key)) return 'Latin'
  if (/[\u0400-\u04ff]/.test(key)) return 'Cyrillic'
  return 'another character'
}

function asPixels(bytes: Uint8Array): Uint8ClampedArray<ArrayBuffer> {
  return new Uint8ClampedArray(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength)
}

export default function RemoteScreen({
  visible,
  active = false,
  focusRequest = 0,
  sessionId,
  quick,
  credentialId,
  admin,
  look,
  password,
  onPhase,
  onSession,
  onNotice,
  onMeasured,
  onSignedOut,
  onTypingLanguage,
  layoutFix = 0
}: Props): JSX.Element {
  const [clipboardStatus, setClipboardStatus] = useState('')
  /** This Mac's input language, kept for the pane's mark. */
  const [macLanguage, setMacLanguage] = useState<string | null>(null)
  /** The language shown large over the desktop for a moment; `at` restarts it. */
  const [hud, setHud] = useState<{ language: string; at: number } | null>(null)
  /** Set by the keyboard: Alt+Shift over there, on the pane's say-so. */
  const fixLayoutRef = useRef<(() => void) | null>(null)
  const t = useT()
  const visibleRef = useRef(visible)
  visibleRef.current = visible
  const containerRef = useRef<HTMLDivElement | null>(null)
  /**
   * Where the keyboard actually is: a text field nobody sees, inside the screen.
   *
   * The screen itself is a div, and Chromium hands a key to a div without
   * passing it through the system's text input. That is fine until the Mac
   * changes layout — the keys typed in that moment arrived as a burst, out of
   * order and one short, where the same fingers in a terminal (xterm keeps a
   * hidden textarea for the same reason) or in Chrome's address bar came
   * through whole. So the focus sits here, and the keys bubble up to the
   * screen's handlers exactly as before; see `takeKeyboard`.
   */
  const keysRef = useRef<HTMLTextAreaElement | null>(null)
  /**
   * What the far end has been told to hold, so a release that never arrives can
   * be noticed and made good. A ref rather than a local of the keyboard effect
   * because the mouse needs it too — see `syncModifiers`.
   */
  const heldRef = useRef<Set<string>>(new Set())
  /**
   * Whether ⌘Tab has the far end's window switcher open, with Alt held over
   * there for the ⌘ held here. See `switchWindows`.
   */
  const switchingRef = useRef(false)
  /**
   * The lock states the far end was last told, or null while that is not
   * known — a new session, or just after a lock key went through as a key.
   * See `syncLocks`.
   */
  const locksRef = useRef<number | null>(null)
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
  const onSessionRef = useRef(onSession)
  onSessionRef.current = onSession
  const onMeasuredRef = useRef(onMeasured)
  onMeasuredRef.current = onMeasured
  const onNoticeRef = useRef(onNotice)
  onNoticeRef.current = onNotice
  const onSignedOutRef = useRef(onSignedOut)
  onSignedOutRef.current = onSignedOut
  const onTypingLanguageRef = useRef(onTypingLanguage)
  onTypingLanguageRef.current = onTypingLanguage

  useEffect(() => {
    let alive = true
    void window.td.ui.inputLanguage().then((language) => {
      if (alive) setMacLanguage(language)
    })
    const stop = window.td.ui.onInputLanguage(setMacLanguage)
    return () => {
      alive = false
      stop()
    }
  }, [])

  // Letters follow this Mac only while they go over as its characters.
  const typesAsText = look?.typeAsText !== false
  useEffect(() => {
    onTypingLanguageRef.current?.(typesAsText ? macLanguage : null)
  }, [typesAsText, macLanguage])
  useEffect(() => () => onTypingLanguageRef.current?.(null), [])

  useEffect(() => {
    if (!hud) return
    const timer = window.setTimeout(() => setHud(null), LANGUAGE_HUD)
    return () => window.clearTimeout(timer)
  }, [hud])

  useEffect(() => {
    if (layoutFix > 0) fixLayoutRef.current?.()
  }, [layoutFix])
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
      commandAsAlt: switchingRef.current,
      ignore: options.ignore,
      press: options.press
    })
    if (fixes.length > 0) {
      diag(
        'rdp',
        `modifier repair ${fixes.map((f) => `${f.code} ${f.down ? 'down' : 'up'}`).join(', ')}`
      )
    }
    for (const fix of fixes) {
      if (!sendKey(fix.code, fix.down)) continue
      if (fix.down) heldRef.current.add(fix.code)
      else heldRef.current.delete(fix.code)
    }
  }

  /**
   * Makes the far end's Num, Caps and Scroll Lock agree with this keyboard's.
   *
   * The same shape as `syncModifiers`, and for the same reason: the event knows
   * the truth, so whatever the far end was last told is corrected from it. A
   * lock key's own press is let through as a key — it toggles both ends alike —
   * and leaves the far end's state unknown until an event reports it settled.
   */
  function syncLocks(event: { getModifierState(state: string): boolean }, code?: string): void {
    if (code !== undefined && isLockKey(code)) {
      locksRef.current = null
      return
    }
    const flags = lockFlags((state) => event.getModifierState(state), IS_MAC)
    if (flags === locksRef.current) return
    diag('rdp', `lock sync ${flags}`)
    locksRef.current = flags
    tell({ a: 'sync', flags })
  }

  /**
   * FreeRDP's focus-in: a Tab release either side of a Synchronize event, as
   * mstsc sends. The Synchronize carries lock states, so it is sent with the
   * ones the far end already has — never with nothing, which turns them all
   * off. Until they are known it is left out; the first key or mouse move
   * sends them.
   */
  function focusIn(): void {
    const flags = locksRef.current
    if (flags !== null) tell({ a: 'focus', flags })
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

  /** Gives this desktop the keyboard: its hidden field, see `keysRef`. */
  function takeKeyboard(): void {
    ;(keysRef.current ?? containerRef.current)?.focus()
  }

  /**
   * Whatever text made it into the hidden field, sent on as characters.
   *
   * Every key is stopped on its way down, so ordinarily nothing does. What
   * can is text the system composes on its own — an input method, a dead key
   * finished off — which arrives as input rather than as a key. It goes over
   * as Unicode, the way a key the keyboard has no scancode for does, and the
   * field is emptied so nothing gathers there.
   */
  function sendComposed(field: HTMLTextAreaElement): void {
    const text = field.value
    field.value = ''
    for (const character of text) {
      const unit = unicodeKey(character)
      if (unit === undefined) continue
      tell({ a: 'unicode', code: unit, down: true })
      tell({ a: 'unicode', code: unit, down: false })
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

  /**
   * Buttons pressed on the desktop and not yet let go, and where the pointer
   * last was on it.
   *
   * A press starts on the desktop but may end anywhere — over the toolbar,
   * another pane, outside the window. Listened for on the pane alone, that
   * release never reached the far end, which went on holding the button: a
   * selection that followed the pointer, a window stuck to it. So while a
   * button is down the release is listened for on the whole document, and a
   * button still down when the window loses focus is let go of by hand.
   */
  const heldButtons = useRef(new Set<number>())
  const lastPoint = useRef<{ x: number; y: number }>({ x: 0, y: 0 })

  function sendButton(button: number, down: boolean, at: { x: number; y: number }): void {
    const event = buttonEvent(button, down)
    if (!event) return
    tell({ a: event.extended ? 'xmouse' : 'mouse', flags: event.flags, x: at.x, y: at.y })
  }

  function releaseButton(event: MouseEvent): void {
    if (!heldButtons.current.delete(event.button)) return
    const at = pointOf(event) ?? lastPoint.current
    lastPoint.current = at
    sendButton(event.button, false, at)
    if (heldButtons.current.size === 0) {
      document.removeEventListener('mouseup', onDocumentMouseUp, true)
    }
  }
  const releaseButtonRef = useRef(releaseButton)
  releaseButtonRef.current = releaseButton
  // One listener for the life of the pane, so the one added is the one removed.
  const onDocumentMouseUp = useRef((event: MouseEvent) => releaseButtonRef.current(event)).current

  function pressButton(event: React.MouseEvent, at: { x: number; y: number }): void {
    if (!buttonEvent(event.button, true)) return
    if (heldButtons.current.size === 0) {
      document.addEventListener('mouseup', onDocumentMouseUp, true)
    }
    heldButtons.current.add(event.button)
    sendButton(event.button, true, at)
  }

  /** Every button still down goes up, where the pointer last was. */
  function releaseButtons(): void {
    for (const button of heldButtons.current) sendButton(button, false, lastPoint.current)
    heldButtons.current.clear()
    document.removeEventListener('mouseup', onDocumentMouseUp, true)
  }
  const releaseButtonsRef = useRef(releaseButtons)
  releaseButtonsRef.current = releaseButtons

  useEffect(() => () => releaseButtonsRef.current(), [])

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
      // Even a frame already in the pipe when hidden must be acknowledged.
      // The client stops producing pixels while hidden, keeping its framebuffer.
      if (!context || !visibleRef.current) {
        tell({ a: 'ack' })
        return
      }
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
          quick,
          width: size?.width ?? 1280,
          height: size?.height ?? 800,
          scale: size ? Math.min(500, Math.max(100, Math.round(size.factor * 100))) : undefined,
          password,
          credentialId,
          admin
        })
        if (!alive) {
          void window.td.rdp.desktopStop(id)
          return
        }
        idRef.current = id
        locksRef.current = null
        onSessionRef.current?.(id)
        tell({ a: 'visible', value: visibleRef.current })
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
              if (visibleRef.current) applyCursor()
            }
          }),
          window.td.rdp.onDesktopEvent(id, (event) => {
            const what = String(event.e ?? '')
            if (what === 'clipboard-transfer') {
              const state = String(event.state)
              setClipboardStatus(
                state === 'cancelled'
                  ? 'cancelled'
                  : state === 'ready'
                    ? 'ready'
                    : state === 'error'
                      ? `error:${String(event.detail ?? '')}${
                          event.where ? `\n${String(event.where)}` : ''
                        }`
                      : `progress:${Number(event.total) > 0 ? Math.floor((Number(event.received) / Number(event.total)) * 100) : 0}`
              )
            } else if (what === 'connected' || what === 'size') {
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
            } else if (
              what === 'ended' &&
              onSignedOutRef.current &&
              endedBySignOut(event.errinfo, event.code)
            ) {
              onSignedOutRef.current()
            } else if (what === 'closed' || what === 'ended') {
              onPhaseRef.current({
                at: 'closed',
                reason: String(event.detail || 'The session ended')
              })
            } else if (what === 'logon') {
              // The host's own explanation, which is the better one when the
              // host is refusing. Most of these are not refusals: "the session
              // continues" is what a host sends on putting you back into the
              // session you already had, and taking that for a failure closed
              // the pane it was reporting on, before the first frame, every
              // time.
              const detail = String(event.detail ?? '')
              if (isRefusal(event.data, event.type))
                onPhaseRef.current({ at: 'failed', reason: detail })
              else onNoticeRef.current(detail)
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
      onSessionRef.current?.(undefined)
      if (id) void window.td.rdp.desktopStop(id)
    }
    // Deliberately once: a change of host or password is a different session,
    // and the pane remounts this component for one. Everything reactive that
    // the callbacks read is held in a ref above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    tell({ a: 'visible', value: visible })
    if (visible) applyCursor()
    else if (containerRef.current?.contains(document.activeElement)) {
      const focused = document.activeElement as HTMLElement
      focused.blur()
    }
    // Session starts separately and sends the current visibility after it opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible])

  /*
   * A desktop that has just been opened takes the keyboard, as a new terminal
   * does: it was double-clicked, picked from the palette, or retried, and it
   * is what is about to be typed into. Only the pane in front of its tab — of
   * several opened at once, that one — and never out of a field being filled
   * in elsewhere while it connects, the tree's filter or a dialog.
   */
  useEffect(() => {
    if (!active) return
    const focused = document.activeElement as HTMLElement | null
    const typing =
      focused !== null &&
      focused.closest('.pane') === null &&
      (['INPUT', 'TEXTAREA', 'SELECT'].includes(focused.tagName) || focused.isContentEditable)
    if (!typing) takeKeyboard()
    // Once, at mount: a retry is a remount and is asked again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /*
   * The value at mount is an old request, made before this desktop existed,
   * and is answered by the mount itself above: only a click from here on
   * moves the keyboard.
   */
  const answeredRequest = useRef(focusRequest)
  useEffect(() => {
    if (focusRequest === answeredRequest.current) return
    answeredRequest.current = focusRequest
    if (active) takeKeyboard()
    // Only a new request focuses; becoming active by itself does not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRequest])

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
    /*
     * A pinned size is asked for too — not when the pane changes, which it
     * ignores by being the same size whatever the pane does, but when the pin
     * itself changes. Returning early for it meant a new fixed size saved for an
     * open desktop was never sent at all.
     */
    const send = (): void => {
      layOut()
      if (!idRef.current) return
      const size = desired()
      if (!size) return
      // Zero leaves the field unstated, which the far end must ignore — so a
      // host that never asked for this is unaffected by it.
      const scale = lookRef.current?.sendDensity
        ? Math.min(500, Math.max(100, Math.round(size.factor * 100)))
        : 0
      const stated = `${size.width}×${size.height}`
      // The density is half of the request: a change of it alone, at the same
      // size, went unsent when only the size was compared.
      if (stated === askedRef.current && scale === scaleRef.current) return
      askedRef.current = stated
      scaleRef.current = scale

      tell({ a: 'resize', width: size.width, height: size.height, scale })
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
    // The settings this effect follows have just changed, or the pane has just
    // opened: either way, ask for what they now make of it. A session not yet
    // started is sized when it starts, and asks nothing here.
    send()

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
    /**
     * Keys whose press went as a character, so their release is not sent as a
     * key that was never pressed. See `textKey`.
     */
    const typed = new Set<string>()
    /**
     * Keys pressed while the far layout is being switched — see
     * `alignLanguage` — held back until it is done. Typed straight after fn,
     * a letter would otherwise land between that Alt and its Shift and arrive
     * as Alt+letter: a menu opening in whatever program was in front.
     */
    const waiting: Array<() => void> = []
    let switchingLayout = false
    /** When this Mac last said its language changed; see `LANGUAGE_WATCH`. */
    let languageChangedAt = Number.NEGATIVE_INFINITY
    /**
     * The Mac's language, waiting for a pause in the typing to be matched over
     * there — see `alignLanguage` for why it waits — and the timer counting
     * down to that pause.
     */
    let languageWanted: string | null = null
    let languageTimer: number | undefined

    /**
     * ⌘Tab, as the Alt+Tab it is on Windows.
     *
     * It only ever arrives in full screen, where `systemHotkeys` in the main
     * process has asked macOS to let it through; anywhere else the system keeps
     * it. Held ⌘ with Tab tapped is Alt held with Tab tapped, so ⌘ becomes Alt
     * for as long as it stays down — Shift walks back, the arrows and Escape
     * work in the switcher as they would there — and letting go of ⌘ lets go
     * of Alt, which picks the window.
     *
     * Alt goes down before whatever ⌘ was standing for comes up. A Windows key
     * released with nothing pressed since opens the Start menu, and Alt in
     * between is exactly the something that stops it.
     */
    const switchWindows = (state: { getModifierState(state: string): boolean }): void => {
      if (!switchingRef.current) {
        switchingRef.current = true
        diag('rdp', '⌘Tab: switching windows as Alt+Tab')
        if (!held.has('AltLeft') && !held.has('AltRight') && sendKey('AltLeft', true)) {
          held.add('AltLeft')
        }
        // Lets go of the Windows key or Ctrl that ⌘ was, now that ⌘ is Alt.
        syncModifiers(state, { ignore: 'Tab' })
      }
      sendKey('Tab', true)
      sendKey('Tab', false)
    }

    /** ⌘ let go while switching: Alt comes up and the window is chosen. */
    const stopSwitching = (event: KeyboardEvent): void => {
      switchingRef.current = false
      diag('rdp', '⌘Tab: done switching')
      for (const code of ['AltLeft', 'AltRight']) {
        if (held.delete(code)) sendKey(code, false)
      }
      // A real Alt still held, or Shift, is put right from the event.
      syncModifiers(event, { press: false })
    }

    const onKeyDown = (event: KeyboardEvent): void => {
      if (!container.contains(document.activeElement)) return
      // Still typing: the far layout is matched when this stops.
      if (languageTimer !== undefined) alignWhenIdle()
      if (switchingLayout) {
        event.preventDefault()
        event.stopPropagation()
        waiting.push(() => onKeyDown(event))
        return
      }
      const code = substituteCommand(event.code, lookRef.current?.commandAsControl === true)
      diagKey('rdp', event, `held=${[...held].join(',') || '-'}`)
      // Every key carries the truth about every modifier, so the one this event
      // is about is left alone and the rest are made to agree.
      syncModifiers(event, { ignore: code })
      syncLocks(event, event.code)

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
      if (IS_MAC && event.metaKey && !event.altKey && event.code === 'Tab') {
        event.preventDefault()
        event.stopPropagation()
        switchWindows(event)
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

      // A quick desktop has no saved look, and takes the default with it.
      const asText = lookRef.current?.typeAsText !== false
      const text = textKey(event, asText)
      const sinceChange = performance.now() - languageChangedAt
      if (sinceChange < LANGUAGE_WATCH) {
        diag(
          'rdp',
          `${Math.round(sinceChange)} ms after the layout change: ${scriptOf(event.key)}, sent as ${text !== undefined ? 'text' : 'a key'}`
        )
      }
      if (text !== undefined) {
        tell({ a: 'unicode', code: text, down: true })
        tell({ a: 'unicode', code: text, down: false })
        typed.add(event.code)
        return
      }
      // Half of a character: the finished one arrives with the next key.
      if (asText && event.key === 'Dead') return

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
      if (switchingLayout) {
        event.preventDefault()
        event.stopPropagation()
        waiting.push(() => onKeyUp(event))
        return
      }
      const code = substituteCommand(event.code, lookRef.current?.commandAsControl === true)
      diagKey('rdp', event, `held=${[...held].join(',') || '-'}`)
      event.preventDefault()
      event.stopPropagation()
      if (switchingRef.current && (event.code === 'MetaLeft' || event.code === 'MetaRight')) {
        // What ⌘ stood for was let go when switching began.
        stopSwitching(event)
        return
      }
      held.delete(code)
      if (!typed.delete(event.code)) sendKey(code, false)
      /*
       * And again afterwards, because a release can be the thing that puts the
       * two ends out of step rather than the thing that fixes it. With ⌘ acting
       * as Ctrl, letting go of ⌘ while the real Ctrl is still held sends the one
       * Ctrl-up both keys share, and the far end stops holding a key the hand
       * has not left.
       */
      syncModifiers(event, { ignore: code })
      // After the release a lock key's state has settled, so it is read here.
      syncLocks(event)
      // A held modifier postponed alignment. Its release must retry it even
      // if the language notification's original idle timer has already fired.
      if (
        languageWanted !== null &&
        ['AltLeft', 'AltRight', 'ShiftLeft', 'ShiftRight'].includes(code)
      )
        alignWhenIdle()
    }

    /** Everything still down goes up, because nothing else will report it. */
    const releaseAll = (): void => {
      diag('rdp', `focus lost, releasing ${[...held].join(',') || 'nothing'}`)
      for (const code of held) sendKey(code, false)
      held.clear()
      typed.clear()
      switchingRef.current = false
      releaseButtonsRef.current()
      focusIn()
    }

    // Menu accelerators must belong to the focused desktop in windowed mode
    // too. Use the destination on blur: activeElement can briefly be body,
    // and moving between desktops must not let another pane clear the claim.
    const captureFor = (target: EventTarget | null): void => {
      window.td.ui.setKeyboardCapture(
        target instanceof Element && target.closest('.graphical-screen') !== null
      )
    }
    /**
     * The far side's layout, kept in step with this Mac's.
     *
     * What is typed never depended on it — letters go over as the characters
     * this Mac made, see `textKey` — but the language on its taskbar did, and
     * so does any program that reads keys rather than text. RDP has no message
     * for a client that changed its layout, so the session starts in the one
     * this Mac had at connect (main sends it with the start), and afterwards
     * this presses the far side's own Alt+Shift whenever this Mac's language
     * changes under a focused desktop, or differs from it on coming back.
     *
     * Alt+Shift rather than Win+Space: it is Windows' own default for changing
     * the input language, on every version, it opens no flyout, and it is what
     * people already press there — Win+Space was tried first and a Server's
     * taskbar did not move for it. Pressed at a hand's pace rather than all in
     * one instant, since the language hotkey is read from the key-up of a
     * combination and a burst of four events is not a hand.
     *
     * And only in a pause. Windows drops and reorders characters that arrive
     * while it is changing language under a program — a letter typed straight
     * after fn came out as a letter from the middle of the word — and the
     * notice from macOS arrives some 250 ms after fn, by when the next word is
     * well under way. What is typed does not need the far layout at all, so
     * the switch waits until the keys have been still for `LANGUAGE_IDLE`,
     * and the taskbar catches up then.
     *
     * Either means "the next language", not "this one", so what the far side
     * has is remembered here rather than known. With the usual two languages on
     * each side that is the same thing. A language changed over there by hand
     * — from its language bar, or its own shortcut — is not seen, and the two
     * then run the wrong way round until ⌥⇧ over there, or a click on the
     * pane's language mark, puts them back; what is typed stays right
     * throughout, and the mark says what that is.
     */
    let farLanguage: string | null = null
    /** This Mac's language as last heard, for the fix and the large label. */
    let macNow: string | null = null
    void window.td.ui.inputLanguage().then((language) => {
      farLanguage ??= language
      macNow ??= language
    })
    const switchTimers = new Set<number>()
    /** Not over a hand already holding either key: the press would be its own. */
    const handOnAltShift = (): boolean =>
      ['AltLeft', 'AltRight', 'ShiftLeft', 'ShiftRight'].some((code) => held.has(code))
    const alignLanguage = (language: string | null): void => {
      if (!language || language === farLanguage) return
      if (farLanguage === null) {
        farLanguage = language
        return
      }
      // Not while it is not ours to press keys in, and not into a session that
      // is not there yet: the press would be lost and the memory of it kept.
      if (!visibleRef.current || !container.contains(document.activeElement)) return
      if (!idRef.current) return
      if (handOnAltShift()) return
      diag('rdp', `layout ${farLanguage} → ${language}: Alt+Shift over there`)
      pressAltShift()
      farLanguage = language
    }
    /** The far side's own language hotkey, at a hand's pace, keys held back meanwhile. */
    const pressAltShift = (): void => {
      const presses: Array<[string, boolean]> = [
        ['AltLeft', true],
        ['ShiftLeft', true],
        ['ShiftLeft', false],
        ['AltLeft', false]
      ]
      switchingLayout = true
      presses.forEach(([code, down], step) => {
        const timer = window.setTimeout(() => {
          switchTimers.delete(timer)
          sendKey(code, down)
          if (step < presses.length - 1) return
          // Done: what was typed meanwhile goes now, in the order it was typed.
          switchingLayout = false
          for (const run of waiting.splice(0)) run()
        }, step * LANGUAGE_KEY_GAP)
        switchTimers.add(timer)
      })
    }
    /**
     * The pane's mark was clicked: the far taskbar shows the other language.
     *
     * Nothing over there can be read, so it is taken on the word of whoever
     * is looking at both. One Alt+Shift turns it round, and from then on the
     * far side is believed to have what this Mac has.
     */
    fixLayoutRef.current = (): void => {
      if (!idRef.current || switchingLayout || handOnAltShift()) return
      window.clearTimeout(languageTimer)
      languageTimer = undefined
      diag('rdp', 'layout put right by hand: Alt+Shift over there')
      pressAltShift()
      farLanguage = macNow ?? farLanguage
    }
    /** The language letters go in, large over the desktop for a moment. */
    const showLanguage = (): void => {
      if (!macNow || lookRef.current?.typeAsText === false) return
      if (!visibleRef.current || !container.contains(document.activeElement)) return
      setHud({ language: macNow, at: performance.now() })
    }
    /** Matches the far layout once the keys have been still for a while. */
    const alignWhenIdle = (language: string | null = languageWanted): void => {
      languageWanted = language
      window.clearTimeout(languageTimer)
      languageTimer = window.setTimeout(() => {
        languageTimer = undefined
        alignLanguage(languageWanted)
      }, LANGUAGE_IDLE)
    }
    const stopLanguage = window.td.ui.onInputLanguage((language) => {
      languageChangedAt = performance.now()
      macNow = language
      showLanguage()
      alignWhenIdle(language)
    })

    /** Whether the keys are already here, so coming back is told from moving inside. */
    let holdingKeys = false
    const onFocus = (): void => {
      captureFor(document.activeElement)
      // The layout may have changed while another application had the keys.
      if (container.contains(document.activeElement)) {
        void window.td.ui.inputLanguage().then((language) => {
          macNow = language ?? macNow
          // Said on arriving, before the first key: a password typed in the
          // wrong language is typed blind, and nothing else on screen tells.
          if (!holdingKeys) {
            holdingKeys = true
            showLanguage()
          }
          alignWhenIdle(language)
        })
      }
    }
    const onBlur = (event: FocusEvent): void => {
      releaseAll()
      captureFor(event.relatedTarget)
      if (!(event.relatedTarget instanceof Node && container.contains(event.relatedTarget)))
        holdingKeys = false
    }
    const onWindowBlur = (): void => {
      releaseAll()
      window.td.ui.setKeyboardCapture(false)
      holdingKeys = false
    }

    /**
     * The keys the main process had to take before this window could see them.
     *
     * Two reasons it has to, and both are things this end cannot reach. Chromium
     * zooms the whole interface on Ctrl with `+`, `-` or `0`; and a menu
     * accelerator — ⌘W for Close Window, ⌘R, ⌘Q — is answered before the page
     * is told anything at all. While a session has focus the main process
     * takes every combination for that reason and hands it back here, where it
     * goes to the far end like any other key.
     *
     * The modifier itself was never taken, so it is already down over there and
     * the pair arrives as the combination it was typed as.
     *
     * Every mounted pane hears this; only the one actually holding focus
     * acts on it.
     */
    const onForwarded = (key: ForwardedKey): void => {
      if (!visibleRef.current || !container.contains(document.activeElement)) return
      if (switchingLayout) {
        waiting.push(() => onForwarded(key))
        return
      }
      diag(
        'rdp',
        `forwarded from main ${key.code} mods=${describeModifiers({ ctrl: key.control, shift: key.shift, alt: key.alt, meta: key.meta })}`
      )
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
      if (IS_MAC && key.meta && !key.alt && key.code === 'Tab') {
        switchWindows(modifierStateOf(key))
        return
      }
      syncModifiers(modifierStateOf(key), { ignore: key.code })
      sendKey(key.code, true)
      sendKey(key.code, false)
    }
    const stopForwarded = window.td.ui.onForwardKey(onForwarded)

    container.addEventListener('keydown', onKeyDown)
    container.addEventListener('keyup', onKeyUp)
    container.addEventListener('focus', onFocus, true)
    container.addEventListener('blur', onBlur, true)
    window.addEventListener('focus', onFocus)
    window.addEventListener('blur', onWindowBlur)
    document.addEventListener('fullscreenchange', onFocus)

    return () => {
      fixLayoutRef.current = null
      stopForwarded()
      stopLanguage()
      window.clearTimeout(languageTimer)
      for (const timer of switchTimers) window.clearTimeout(timer)
      container.removeEventListener('keydown', onKeyDown)
      container.removeEventListener('keyup', onKeyUp)
      container.removeEventListener('focus', onFocus, true)
      container.removeEventListener('blur', onBlur, true)
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('blur', onWindowBlur)
      document.removeEventListener('fullscreenchange', onFocus)
      // React has already removed this element when passive cleanup runs.
      // Re-read the destination so closing an unfocused pane keeps its
      // neighbour's claim, while closing the focused one releases it.
      captureFor(document.activeElement)
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
        takeKeyboard()
      } else {
        keyboard?.unlock()
      }
    }

    document.addEventListener('fullscreenchange', onChange)
    return () => {
      document.removeEventListener('fullscreenchange', onChange)
      // A pane closed while full screen leaves nothing behind to say so, and a
      // claim left standing would go on taking keys for a session that is gone.
      if (holding) {
        keyboard?.unlock()
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
    syncLocks(event)

    lastPoint.current = at
    if (down === null) {
      tell({ a: 'mouse', flags: PTR.move, x: at.x, y: at.y })
      return
    }
    if (!buttonEvent(event.button, down)) return
    event.preventDefault()
    // Releases arrive through the document; see heldButtons.
    if (down) pressButton(event, at)
  }

  return (
    <div
      className="graphical-screen"
      ref={containerRef}
      // So the keyboard can reach it at all: a div is not focusable otherwise,
      // and every key would go to whatever was focused before the pane opened.
      tabIndex={0}
      onMouseDown={(e) => {
        takeKeyboard()
        onMouse(e, true)
      }}
      onMouseUp={(e) => e.preventDefault()}
      onMouseMove={(e) => onMouse(e, null)}
      onFocus={(e) => {
        // Focused itself — by Tab, or by anything that focuses the screen —
        // it passes the keyboard on to the field that takes it properly.
        if (e.target === e.currentTarget && keysRef.current) {
          keysRef.current.focus()
          return
        }
        focusIn()
      }}
      // The far side's own menu, not this machine's.
      onContextMenu={(e) => e.preventDefault()}
      onWheel={(e) => {
        e.preventDefault()
        const at = pointOf(e)
        if (!at) return
        // A wheel turn is an ordinary pointer event with the rotation folded
        // into its flags; see wheelFlags, which is where the folding is stated
        // and tested. wheelTurns filters the small cross-axis noise a trackpad
        // adds to an otherwise one-dimensional gesture.
        for (const turn of wheelTurns(e.deltaX, e.deltaY, e.deltaMode)) {
          const flags = wheelFlags(turn.units, turn.horizontal)
          if (flags !== null) tell({ a: 'mouse', flags, x: at.x, y: at.y })
        }
      }}
    >
      <textarea
        ref={keysRef}
        className="graphical-keys"
        aria-label={t('Keyboard for the remote desktop')}
        tabIndex={-1}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        onInput={(e) => {
          // Mid-composition the text is not finished; it goes when it is.
          if ((e.nativeEvent as InputEvent).isComposing) return
          sendComposed(e.currentTarget)
        }}
        onCompositionEnd={(e) => sendComposed(e.currentTarget)}
      />
      <canvas ref={canvasRef} className="graphical-canvas" />
      {hud && (
        <div key={hud.at} className="graphical-language" aria-hidden="true">
          {hud.language.toUpperCase()}
        </div>
      )}
      {clipboardStatus && (
        <div
          role="status"
          onMouseDown={(e) => e.stopPropagation()}
          onMouseUp={(e) => e.stopPropagation()}
          onMouseMove={(e) => e.stopPropagation()}
          style={{
            position: 'absolute',
            bottom: 8,
            left: 8,
            maxWidth: '90%',
            padding: '6px 10px',
            background: 'var(--bg-2)',
            color: 'var(--text)',
            borderRadius: 4
          }}
        >
          {clipboardStatus === 'cancelled'
            ? t('File copy cancelled')
            : clipboardStatus === 'ready'
              ? t('Files ready to paste')
              : clipboardStatus.startsWith('error:')
                ? `${t('File copy failed')}: ${explainFailure(t, clipboardStatus.slice(6))}`
                : `${t('Receiving clipboard files')} ${clipboardStatus.slice(9)}%`}
          <button
            aria-label={t('Close')}
            onClick={() => setClipboardStatus('')}
            style={{ marginLeft: 8 }}
          >
            ×
          </button>
        </div>
      )}
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
