/**
 * A page's glyph in the list down the side of a paged dialog — Settings, and
 * the dialogs of a host, a group and a repository — drawn in the stroke of the
 * app's own icons.
 */
export type PageGlyph =
  | 'general'
  | 'tree'
  | 'terminal'
  | 'files'
  | 'accounts'
  | 'security'
  | 'backup'
  | 'about'
  | 'host'
  | 'login'
  | 'tunnels'
  | 'desktop'
  | 'appearance'
  | 'git'

export default function PageIcon({ page }: { page: PageGlyph }): JSX.Element {
  const stroke = {
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.3,
    strokeLinecap: 'round',
    strokeLinejoin: 'round'
  } as const
  const shapes: Record<PageGlyph, JSX.Element> = {
    host: (
      <>
        <rect x="2" y="2.5" width="12" height="4.5" rx="1.2" {...stroke} />
        <rect x="2" y="9" width="12" height="4.5" rx="1.2" {...stroke} />
        <path d="M4.5 4.75h.01M4.5 11.25h.01" {...stroke} strokeWidth={1.8} />
      </>
    ),
    login: (
      <>
        <circle cx="5.5" cy="10.5" r="3" {...stroke} />
        <path d="M7.6 8.4L13.5 2.5M11.5 4.5l1.6 1.6M10 6l1.2 1.2" {...stroke} />
      </>
    ),
    tunnels: <path d="M2.5 5.5h10l-2.5-2.5M13.5 10.5h-10l2.5 2.5" {...stroke} />,
    desktop: (
      <>
        <rect x="1.5" y="2.5" width="13" height="9" rx="1.5" {...stroke} />
        <path d="M6 14h4M8 11.5V14" {...stroke} />
      </>
    ),
    appearance: (
      <>
        <path
          d="M8 1.8a6.2 6.2 0 1 0 0 12.4c.9 0 1.4-.6 1.4-1.3 0-.9-.8-1.2-.8-2 0-.7.6-1.2 1.3-1.2h1.7a2.6 2.6 0 0 0 2.6-2.6C14.2 4.3 11.4 1.8 8 1.8z"
          {...stroke}
        />
        <circle cx="5" cy="7" r=".2" {...stroke} strokeWidth={1.8} />
        <circle cx="7.6" cy="4.6" r=".2" {...stroke} strokeWidth={1.8} />
        <circle cx="10.6" cy="5.4" r=".2" {...stroke} strokeWidth={1.8} />
      </>
    ),
    git: (
      <>
        <circle cx="4.5" cy="3.5" r="1.6" {...stroke} />
        <circle cx="4.5" cy="12.5" r="1.6" {...stroke} />
        <circle cx="11.5" cy="5.5" r="1.6" {...stroke} />
        <path d="M4.5 5.1v5.8M11.5 7.1c0 2.6-3.5 2.4-6.2 4.2" {...stroke} />
      </>
    ),
    general: (
      <>
        <path d="M2.5 4.5h5.7M11.8 4.5h1.7M2.5 11.5h1.7M7.8 11.5h5.7" {...stroke} />
        <circle cx="10" cy="4.5" r="1.8" {...stroke} />
        <circle cx="6" cy="11.5" r="1.8" {...stroke} />
      </>
    ),
    tree: <path d="M4 2.5v9h3.5M4 7h3.5M9.5 3.5h4M9.5 7h4M9.5 11.5h4M2.5 3.5h3" {...stroke} />,
    terminal: (
      <>
        <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" {...stroke} />
        <path d="M4.5 6l2 2-2 2M8 10.5h3.5" {...stroke} />
      </>
    ),
    files: (
      <path
        d="M1.8 4.2c0-.7.5-1.2 1.2-1.2h3l1.5 1.7H13c.7 0 1.2.5 1.2 1.2v6.4c0 .7-.5 1.2-1.2 1.2H3c-.7 0-1.2-.5-1.2-1.2z"
        {...stroke}
      />
    ),
    accounts: (
      <>
        <circle cx="8" cy="5.5" r="2.7" {...stroke} />
        <path d="M2.8 13.8c.6-2.6 2.7-4.1 5.2-4.1s4.6 1.5 5.2 4.1" {...stroke} />
      </>
    ),
    security: (
      <>
        <rect x="3" y="7" width="10" height="7" rx="1.3" {...stroke} />
        <path d="M5.3 7V5.2a2.7 2.7 0 0 1 5.4 0V7" {...stroke} />
      </>
    ),
    backup: (
      <>
        <ellipse cx="8" cy="4" rx="5.5" ry="2" {...stroke} />
        <path
          d="M2.5 4v8c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2V4M2.5 8c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2"
          {...stroke}
        />
      </>
    ),
    about: (
      <>
        <circle cx="8" cy="8" r="6.2" {...stroke} />
        <path d="M8 7.3v4" {...stroke} />
        <circle cx="8" cy="4.9" r=".2" {...stroke} strokeWidth={1.6} />
      </>
    )
  }
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false">
      {shapes[page]}
    </svg>
  )
}
