import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useStore } from '../state/store'
import type { OpenMode } from '../state/store'
import { paletteEntries } from '../state/palette'
import type { PaletteEntry as Entry } from '../state/palette'
import ModalBackdrop from './ModalBackdrop'
import { useT } from '../i18n'

export default function HostPalette({ onClose }: { onClose: () => void }): JSX.Element {
  const t = useT()
  const sessions = useStore((s) => s.sessions)
  const groups = useStore((s) => s.groups)
  const trees = useStore((s) => s.inventoryTrees)
  const overrides = useStore((s) => s.inventoryOverrides)
  const gitTrees = useStore((s) => s.gitFolderTrees)
  const gitOverrides = useStore((s) => s.gitFolderOverrides)
  const openTab = useStore((s) => s.openTab)
  const openMany = useStore((s) => s.openMany)

  const credentials = useStore((s) => s.credentials)
  const [query, setQuery] = useState('')
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

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return entries
    return entries.filter((e) => `${e.title} ${e.address} ${e.path}`.toLowerCase().includes(needle))
  }, [entries, query])

  useEffect(() => {
    setCursor(0)
  }, [query])

  // Keep the highlighted row on screen while arrowing through a long list.
  useEffect(() => {
    listRef.current?.querySelector('.palette-row.active')?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  function chosen(): Entry[] {
    if (picked.size > 0) return matches.filter((e) => picked.has(e.id))
    const one = matches[cursor]
    return one ? [one] : []
  }

  function open(mode: OpenMode): void {
    const list = chosen()
    if (list.length === 0) return
    if (list.length === 1 && mode === 'tabs') {
      openTab(list[0].title, list[0].target, list[0].color)
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
          {picked.size > 0
            ? t('Selected: {count} — ⏎ tabs, ⇧⏎ tiled in one, ⌥⏎ a new workspace', {
                count: picked.size
              })
            : t('Tab marks a host for opening several at once')}
        </div>

        <div className="palette-list" ref={listRef}>
          {matches.length === 0 && (
            <div className="palette-empty">
              {entries.length === 0
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
                open('tabs')
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
          <span>⏎ open · ⇧⏎ tile · ⌥⏎ new workspace · Tab mark · ↑↓ move · esc close</span>
          <span>{matches.length} hosts</span>
        </div>
      </div>
    </ModalBackdrop>
  )
}
