import { useCallback, useEffect, useState } from 'react'
import type { SftpEntry } from '../../../shared/types'
import { segmentsOf } from '../../../shared/remotePath'

/**
 * The directory side of the panel: folders only, filled in as they are opened.
 *
 * A remote tree cannot be read ahead of time — every level is a round trip over
 * the wire — so a node holds nothing until it is expanded, and what it holds is
 * kept afterwards so going back up is instant.
 */
export default function SftpTree({
  connectionId,
  path,
  onOpen
}: {
  connectionId?: string
  /** Where the list pane is; the tree reveals and highlights it. */
  path: string
  onOpen: (path: string) => void
}): JSX.Element {
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['/']))
  const [children, setChildren] = useState<Map<string, SftpEntry[]>>(new Map())
  const [loading, setLoading] = useState<Set<string>>(new Set())
  const [failed, setFailed] = useState<Set<string>>(new Set())

  const fetchChildren = useCallback(
    async (dir: string): Promise<void> => {
      if (!connectionId) return
      setLoading((cur) => new Set(cur).add(dir))
      try {
        const list = await window.td.sftp.list(connectionId, dir)
        const dirs = list
          .filter((e) => e.isDirectory)
          .sort((a, b) => a.name.localeCompare(b.name))
        setChildren((cur) => new Map(cur).set(dir, dirs))
        setFailed((cur) => {
          if (!cur.has(dir)) return cur
          const next = new Set(cur)
          next.delete(dir)
          return next
        })
      } catch {
        // A directory that cannot be read keeps its node, marked: the usual
        // cause is permissions, and hiding it would suggest it is not there.
        setChildren((cur) => new Map(cur).set(dir, []))
        setFailed((cur) => new Set(cur).add(dir))
      } finally {
        setLoading((cur) => {
          const next = new Set(cur)
          next.delete(dir)
          return next
        })
      }
    },
    [connectionId]
  )

  // Reveal wherever the list pane went, however it got there — a click here, a
  // typed path, or the terminal's own cd.
  useEffect(() => {
    if (!connectionId || !path.startsWith('/')) return
    const ancestors = segmentsOf(path).map((s) => s.path)
    setExpanded((cur) => {
      const next = new Set(cur)
      for (const dir of ancestors) next.add(dir)
      return next
    })
    for (const dir of ancestors) {
      if (!children.has(dir) && !loading.has(dir)) fetchChildren(dir)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, connectionId])

  // A reconnect gets a fresh tree rather than another host's folders.
  useEffect(() => {
    setChildren(new Map())
    setFailed(new Set())
    setExpanded(new Set(['/']))
  }, [connectionId])

  function toggle(dir: string): void {
    setExpanded((cur) => {
      const next = new Set(cur)
      if (next.has(dir)) next.delete(dir)
      else {
        next.add(dir)
        if (!children.has(dir)) fetchChildren(dir)
      }
      return next
    })
  }

  function renderNode(dir: string, name: string, depth: number): JSX.Element {
    const isOpen = expanded.has(dir)
    const kids = children.get(dir)
    return (
      <div key={dir}>
        <div
          className={`sftp-tree-row ${path === dir ? 'current' : ''}`}
          style={{ paddingLeft: 4 + depth * 12 }}
          title={dir}
          onClick={() => onOpen(dir)}
        >
          <span
            className={`twisty ${isOpen ? 'open' : ''}`}
            onClick={(e) => {
              // Expanding is not navigating: opening a node to look inside it
              // must not move the list pane out from under you.
              e.stopPropagation()
              toggle(dir)
            }}
          >
            {loading.has(dir) ? '·' : '▸'}
          </span>
          <span className="folder">{failed.has(dir) ? '🚫' : '📁'}</span>
          <span className="label">{name}</span>
        </div>
        {isOpen && kids?.map((k) => renderNode(k.path, k.name, depth + 1))}
      </div>
    )
  }

  if (!connectionId) return <div className="sftp-tree" />
  return <div className="sftp-tree">{renderNode('/', '/', 0)}</div>
}
