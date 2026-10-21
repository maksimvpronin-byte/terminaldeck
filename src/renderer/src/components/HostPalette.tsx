import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useStore } from '../state/store'
import type { OpenMode } from '../state/store'
import { paletteEntries } from '../state/palette'
import type { PaletteEntry as Entry } from '../state/palette'
import ModalBackdrop from './ModalBackdrop'
import type { LaunchRequest } from '../hooks/useLaunchRequests'
import { useT } from '../i18n'

export default function HostPalette({
  onClose,
  request
}: {
  onClose: () => void
  /**
   * A host from the command line that fitted several, or none: those are what
   * it shows until the query is changed. See useLaunchRequests.
   */
  request?: LaunchRequest
}): JSX.Element {
  const t = useT()
  const sessions = useStore((s) => s.sessions)
  const groups = useStore((s) => s.groups)
  const trees = useStore((s) => s.inventoryTrees)
  const overrides = useStore((s) => s.inventoryOverrides)
  const gitTrees = useStore((s) => s.gitFolderTrees)
  const gitOverrides = useStore((s) => s.gitFolderOverrides)
  const openHost = useStore((s) => s.openHost)
  const openMany = useStore((s) => s.openMany)

  const credentials = useStore((s) => s.credentials)
  const [query, setQuery] = useState(request?.query ?? '')
  const [cursor, setCursor] = useState(0)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const listRef = useRef<HTMLDivElement | null>(null)

  const entries = useMemo<Entry[]>(
    () =>
      paletteEntries({
        sessions,
        groups,
        inventoryTrees: trees,
        inventoryOverrides: overrides,
        gitFolderTrees: gitTrees,
        gitFolderOverrides: gitOverrides,
        credentials
      }),
    [sessions, groups, trees, overrides, gitTrees, gitOverrides, credentials]
  )

  // The command line's own answer stands while its words are in the box: it
  // matched by short name and through DNS, which the box's search does not.
  const asked = request !== undefined && query === request.query

  const matches = useMemo(() => {
    if (asked && request) return entries.filter((e) => request.ids.includes(e.id))
    const needle = query.trim().toLowerCase()
    if (!needle) return entries
    return entries.filter((e) => `${e.title} ${e.address} ${e.path}`.toLowerCase().includes(needle))
  }, [entries, query, asked, request])

  useEffect(() => {
    setCursor(0)
  }, [query])

  // Keep the highlighted row on screen while arrowing through a long list.
  useEffect(() => {
    listRef.current?.querySelector('.palette-row.active')?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  /** What opening means now: the marked hosts, or the one at `at` — the cursor's row unless said. */
  function chosen(at = cursor): Entry[] {
    if (picked.size > 0) return matches.filter((e) => picked.has(e.id))
    const one = matches[at]
    return one ? [one] : []
  }

  function open(mode: OpenMode, at?: number): void {
    const list = chosen(at)
    if (list.length === 0) return
    if (list.length === 1 && mode === 'tabs') {
      openHost(list[0].title, list[0].target, list[0].color)
    } else {
      openMany(
        list.map((e) => ({ title: e.title, target: e.target, color: e.color })),
        mode
      )
    }
    onClose()
  }

  function toggle(id: string): void {
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function onKeyDown(e: ReactKeyboardEvent): void {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setCursor((c) => Math.min(c + 1, matches.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setCursor((c) => Math.max(c - 1, 0))
    } else if (e.key === ' ' && query === '') {
      // Space only marks while the query is empty, so it stays typable.
      e.preventDefault()
      if (matches[cursor]) toggle(matches[cursor].id)
    } else if (e.key === 'Tab') {
      e.preventDefault()
      if (matches[cursor]) toggle(matches[cursor].id)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      open(e.altKey ? 'workspace' : e.shiftKey ? 'grid' : 'tabs')
    } else if (e.key === 'Escape') {
      onClose()
    }
  }

  return (
    <ModalBackdrop onClose={onClose}>
      <div className="palette">
        <input
          autoFocus
          className="palette-input"
          placeholder={t('Go to host…')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />

        <div className="palette-target">
          {asked && picked.size === 0 && matches.length > 1
            ? t('Several hosts fit “{query}” — choose the one to open', { query })
            : picked.size > 0
              ? t('Selected: {count} — ⏎ tabs, ⇧⏎ tiled in one, ⌥⏎ a new workspace', {
                  count: picked.size
                })
              : t('Tab marks a host for opening several at once')}
        </div>

        <div className="palette-list" ref={listRef}>
          {matches.length === 0 && (
            <div className="palette-empty">
              {asked
                ? t(
                    '“{query}” is not among the saved hosts or the inventories, by name, address or what DNS says it is.',
                    { query }
                  )
                : entries.length === 0
                  ? t('No hosts yet.')
                  : t('Nothing matches “{query}”.', { query })}
            </div>
          )}
          {matches.map((e, i) => (
            <div
              key={e.id}
              className={`palette-row ${i === cursor ? 'active' : ''}`}
              onMouseEnter={() => setCursor(i)}
              onClick={() => {
                setCursor(i)
                // Its own row, said outright: the cursor set just above has
                // not landed yet, and with the arrow keys having moved it
                // since the pointer came in, the row above was opened.
                open('tabs', i)
              }}
            >
              <span
                className="session-dot"
                style={e.color ? { background: e.color } : undefined}
                aria-hidden="true"
              />
              <div className="palette-row-main">
                <span className="palette-name">
                  {picked.has(e.id) ? '✓ ' : ''}
                  {e.title}
                </span>
                <span className="palette-command">
                  {e.address}
                  {e.path ? ` · ${e.path}` : ''}
                </span>
              </div>
            </div>
          ))}
        </div>

        <div className="palette-footer">
          <span>{t('⏎ open · ⇧⏎ tile · ⌥⏎ new workspace · Tab mark · ↑↓ move · esc close')}</span>
          <span>{matches.length} hosts</span>
        </div>
      </div>
    </ModalBackdrop>
  )
}
