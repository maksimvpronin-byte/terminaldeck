import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { SessionGroup, SessionProfile } from '../../../shared/types'
import { resolveAuth } from '../../../shared/authResolution'
import { useStore } from '../state/store'
import type { PaneTarget } from '../state/store'
import ModalBackdrop from './ModalBackdrop'

interface Entry {
  id: string
  title: string
  /** "Prod / Databases" or "Repo / all / db", so duplicates are tellable apart. */
  path: string
  address: string
  color?: string
  target: PaneTarget
}

function pathOf(groupId: string | null, groups: SessionGroup[]): string {
  const parts: string[] = []
  const seen = new Set<string>()
  let cursor = groupId
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor)
    const group = groups.find((g) => g.id === cursor)
    if (!group) break
    parts.unshift(group.name)
    cursor = group.parentId
  }
  return parts.join(' / ')
}

export default function HostPalette({ onClose }: { onClose: () => void }): JSX.Element {
  const sessions = useStore((s) => s.sessions)
  const groups = useStore((s) => s.groups)
  const trees = useStore((s) => s.inventoryTrees)
  const overrides = useStore((s) => s.inventoryOverrides)
  const openTab = useStore((s) => s.openTab)
  const openMany = useStore((s) => s.openMany)

  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const listRef = useRef<HTMLDivElement | null>(null)

  const entries = useMemo<Entry[]>(() => {
    const out: Entry[] = []

    for (const s of sessions) {
      const auth = resolveAuth(s, s.groupId, groups)
      out.push({
        id: s.id,
        title: s.name,
        path: pathOf(s.groupId, groups),
        address: auth.username ? `${auth.username}@${s.host}` : s.host,
        color: s.color,
        target: { kind: 'session', sessionId: s.id }
      })
    }

    const invGroups = trees.flatMap((t) => t.groups)
    for (const tree of trees) {
      for (const raw of tree.sessions) {
        const o = overrides.find((x) => x.nodeId === raw.id)
        const host: SessionProfile = o
          ? {
              ...raw,
              ...Object.fromEntries(
                Object.entries(o).filter(
                  ([k, v]) => k !== 'nodeId' && v !== undefined && v !== null && v !== ''
                )
              )
            }
          : raw
        const auth = resolveAuth(host, host.groupId, invGroups)
        out.push({
          id: host.id,
          title: host.name,
          path: pathOf(host.groupId, invGroups),
          address: auth.username ? `${auth.username}@${host.host}` : host.host,
          color: host.color,
          target: { kind: 'session', sessionId: host.id }
        })
      }
    }
    return out
  }, [sessions, groups, trees, overrides])

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return entries
    return entries.filter((e) =>
      `${e.title} ${e.address} ${e.path}`.toLowerCase().includes(needle)
    )
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

  function open(mode: 'tabs' | 'grid'): void {
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
      open(e.shiftKey ? 'grid' : 'tabs')
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
          placeholder="Go to host…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />

        <div className="palette-target">
          {picked.size > 0
            ? `${picked.size} selected — ⏎ opens them in tabs, ⇧⏎ tiles them in one`
            : 'Tab marks a host for opening several at once'}
        </div>

        <div className="palette-list" ref={listRef}>
          {matches.length === 0 && (
            <div className="palette-empty">
              {entries.length === 0 ? 'No hosts yet.' : `Nothing matches “${query}”.`}
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
          <span>⏎ open · ⇧⏎ tile in one tab · Tab mark · ↑↓ move · esc close</span>
          <span>{matches.length} hosts</span>
        </div>
      </div>
    </ModalBackdrop>
  )
}
