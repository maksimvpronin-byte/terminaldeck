/**
 * Turning what a browser reports into what [MS-RDPBCGR] carries.
 *
 * Small, and here rather than in the pane, because every one of these is a
 * number that is either right or produces a symptom nobody attributes to the
 * mouse: a right-click that pastes, a scroll that goes the wrong way, a back
 * button that does nothing. They are easier to get right against a test than
 * against a remote desktop.
 */

/** Pointer flags, from FreeRDP's input.h, which takes them from the protocol. */
export const PTR = {
  move: 0x0800,
  down: 0x8000,
  left: 0x1000,
  right: 0x2000,
  middle: 0x4000,
  wheel: 0x0200,
  hwheel: 0x0400,
  wheelNegative: 0x0100
} as const

/** The two side buttons travel on a message of their own. */
export const PTR_X = {
  down: 0x8000,
  back: 0x0001,
  forward: 0x0002
} as const

export interface ButtonEvent {
  flags: number
  /** Whether this goes as an extended pointer event rather than an ordinary one. */
  extended: boolean
}

/**
 * A mouse button, as the protocol names it.
 *
 * `button` is `MouseEvent.button`: 0 left, 1 middle, 2 right, 3 back,
 * 4 forward. Note that the browser's order is not the protocol's — middle and
 * right are the other way round — which is exactly the sort of thing this
 * exists to state once.
 */
export function buttonEvent(button: number, down: boolean): ButtonEvent | null {
  switch (button) {
    case 0:
      return { flags: PTR.left | (down ? PTR.down : 0), extended: false }
    case 1:
      return { flags: PTR.middle | (down ? PTR.down : 0), extended: false }
    case 2:
      return { flags: PTR.right | (down ? PTR.down : 0), extended: false }
    case 3:
      return { flags: PTR_X.back | (down ? PTR_X.down : 0), extended: true }
    case 4:
      return { flags: PTR_X.forward | (down ? PTR_X.down : 0), extended: true }
    default:
      return null
  }
}

/**
 * How far a wheel turned, in the units RDP counts in.
 *
 * One notch is 120, the same number Windows uses, and the browser reports
 * something quite different depending on the device: pixels from a trackpad,
 * lines from a wheel, pages from a few. A trackpad produces a stream of small
 * pixel deltas, so this returns the exact proportion rather than rounding each
 * one to a notch — which would turn a gentle scroll into a jumping one and a
 * very gentle one into nothing at all.
 *
 * The sign is flipped on the way: a browser counts down as positive, and the
 * protocol counts a wheel turning away from the hand as positive.
 */
export function wheelUnits(delta: number, deltaMode: number): number {
  // 0 pixels, 1 lines, 2 pages. A line is about 16 pixels and a page about a
  // screen; both are estimates, and both are what every other client uses.
  const pixels = deltaMode === 1 ? delta * 16 : deltaMode === 2 ? delta * 400 : delta
  // 100 pixels to a notch, which is roughly what one detent produces on the
  // trackpads and wheels this was tried against.
  const units = Math.round((-pixels * 120) / 100)
  // The magnitude travels in eight bits, with the ninth carrying the sign.
  return Math.max(-255, Math.min(255, units))
}

/**
 * A wheel turn, as the flags field that carries it.
 *
 * The rotation rides in the low byte of the same field as the flags, and a
 * backwards turn is **not** the magnitude with a sign bit beside it — it is
 * that byte's two's complement, with `wheelNegative` saying to read it that
 * way. The far end computes `-(0x100 - value)`, so a turn of three sent as a
 * plain 3 is read as a turn of 253.
 *
 * Which is not a subtle symptom: scrolling one way moves a line and the other
 * way clears the document. It is stated here, against a test, rather than in
 * the client where it was written from the shape of the field and was wrong.
 */
export function wheelFlags(units: number, horizontal = false): number | null {
  if (units === 0) return null
  const axis = horizontal ? PTR.hwheel : PTR.wheel
  const magnitude = Math.min(255, Math.abs(units))
  if (units > 0) return axis | magnitude
  return axis | PTR.wheelNegative | ((0x100 - magnitude) & 0xff)
}
