/**
 * Pane-layout icons. The filled half shows where the new pane will appear, which
 * the previous glyphs (⬓ / ⬒) failed to convey — they read as the same shape.
 */

const frame = {
  x: 1.5,
  y: 2.5,
  width: 13,
  height: 11
}

export function SplitRightIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">
      <rect
        {...frame}
        rx="1.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <rect x="8" y="2.5" width="6.5" height="11" fill="currentColor" opacity="0.45" />
      <line x1="8" y1="2.5" x2="8" y2="13.5" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  )
}

export function SplitDownIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">
      <rect
        {...frame}
        rx="1.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <rect x="1.5" y="8" width="13" height="5.5" fill="currentColor" opacity="0.45" />
      <line x1="1.5" y1="8" x2="14.5" y2="8" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  )
}

/** The ⟳ glyph renders as a bare arc in several system fonts, so it is drawn. */
export function RefreshIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">
      <path
        d="M13 8a5 5 0 1 1-1.6-3.7"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <path d="M13.2 2.2V5.4H10" fill="none" stroke="currentColor" strokeWidth="1.5"
        strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** Pane leaving its split for a tab of its own. */
export function DetachIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">
      <rect
        x="1.5"
        y="5"
        width="8"
        height="8.5"
        rx="1.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <path
        d="M7.5 8.5 14 2.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <path
        d="M10.2 2.5H14v3.8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function CloseIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">
      <line x1="4" y1="4" x2="12" y2="12" stroke="currentColor" strokeWidth="1.5" />
      <line x1="12" y1="4" x2="4" y2="12" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  )
}
