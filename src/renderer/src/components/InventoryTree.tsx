import { useEffect, useState } from 'react'
import type { InventorySource, SessionGroup, SessionProfile } from '../../../shared/types'
import { resolveAuth } from '../../../shared/authResolution'
import { useStore } from '../state/store'
import InventorySourceDialog from './InventorySourceDialog'
import ContextMenu, { type MenuItem } from './ContextMenu'
import { RefreshIcon } from './icons'

const COLLAPSED_KEY = 'terminaldeck.collapsedInventory'

function loadCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY)
    return new Set(raw ? (JSON.parse(raw) as string[]) : [])
  } catch {
    return new Set()
  }
}

function ago(ts?: number): string {
  if (!ts) return 'never synced'
  const mins = Math.round((Date.now() - ts) / 60000)
  if (mins < 1) return 'synced just now'
  if (mins < 60) return `synced ${mins}m ago`
  const hours = Math.round(mins / 60)
  return hours < 24 ? `synced ${hours}h ago` : `synced ${Math.round(hours / 24)}d ago`
}

export default function InventoryTree({ query }: { query: string }): JSX.Element {
  const sources = useStore((s) => s.inventorySources)
  const trees = useStore((s) => s.inventoryTrees)
  const overrides = useStore((s) => s.inventoryOverrides)
  const syncing = useStore((s) => s.inventorySyncing)
  const gitAvailable = useStore((s) => s.gitAvailable)
  const loadInventory = useStore((s) => s.loadInventory)
  const syncInventory = useStore((s) => s.syncInventory)
  const removeInventorySource = useStore((s) => s.removeInventorySource)
  const clearInventoryOverride = useStore((s) => s.clearInventoryOverride)
  const openTab = useStore((s) => s.openTab)
  const splitPaneWith = useStore((s) => s.splitPaneWith)

  const [editing, setEditing] = useState<InventorySource | 'new' | undefined>(undefined)
  const [collapsed, setCollapsed] = useState<Set<string>>(loadCollapsed)
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)

  useEffect(() => {
    loadInventory()
  }, [loadInventory])

  function toggleCollapsed(id: string): void {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]))
      return next
    })
  }

  const allGroups: SessionGroup[] = trees.flatMap((t) => t.groups)
  const needle = query.trim().toLowerCase()

  /** The host with its local override applied, as it will actually connect. */
  function withOverride(host: SessionProfile): SessionProfile {
    const o = overrides.find((x) => x.hostId === host.id)
    if (!o) return host
    const { hostId: _drop, ...patch } = o
    const clean = Object.fromEntries(
      Object.entries(patch).filter(([, v]) => v !== undefined && v !== null && v !== '')
    )
    return { ...host, ...clean }
  }

  function hostsOf(groupId: string): SessionProfile[] {
    return trees
      .flatMap((t) => t.sessions)
      .filter((h) => h.groupId === groupId)
      .map(withOverride)
      .filter((h) => !needle || `${h.name} ${h.host}`.toLowerCase().includes(needle))
  }

  function subtreeHasMatch(groupId: string): boolean {
    if (hostsOf(groupId).length > 0) return true
    return allGroups.filter((g) => g.parentId === groupId).some((g) => subtreeHasMatch(g.id))
  }

  function connect(host: SessionProfile, colour?: string): void {
    openTab(host.name, { kind: 'session', sessionId: host.id }, colour)
  }

  function hostMenu(host: SessionProfile, colour?: string): MenuItem[] {
    const state = useStore.getState()
    const activeTab = state.tabs.find((t) => t.id === state.activeTabId)
    const auth = resolveAuth(host, host.groupId, allGroups)
    const overridden = overrides.some((o) => o.hostId === host.id)
    return [
      { label: 'Connect', onSelect: () => connect(host, colour) },
      {
        label: 'Connect in split',
        disabled: !activeTab,
        onSelect: () =>
          activeTab &&
          splitPaneWith(
            activeTab.id,
            activeTab.activePaneId,
            'row',
            'after',
            host.name,
            { kind: 'session', sessionId: host.id },
            colour
          )
      },
      {
        label: `Copy ${auth.username ? `${auth.username}@` : ''}${host.host}`,
        separated: true,
        onSelect: () =>
          window.td.clipboard.write(`${auth.username ? `${auth.username}@` : ''}${host.host}`)
      },
      {
        label: 'Clear local override',
        disabled: !overridden,
        onSelect: () => clearInventoryOverride(host.id)
      }
    ]
  }

  function sourceMenu(source: InventorySource): MenuItem[] {
    return [
      { label: 'Sync now', onSelect: () => syncInventory(source.id) },
      { label: 'Edit…', onSelect: () => setEditing(source) },
      {
        label: 'Remove source',
        danger: true,
        separated: true,
        onSelect: () => removeInventorySource(source.id)
      }
    ]
  }

  function renderGroups(parentId: string, depth: number, colour?: string): JSX.Element[] {
    return allGroups
      .filter((g) => g.parentId === parentId)
      .filter((g) => !needle || subtreeHasMatch(g.id))
      .map((g) => {
        const isCollapsed = needle === '' && collapsed.has(g.id)
        return (
          <div className="tree-group" key={g.id}>
            <div
              className="tree-item"
              style={{ paddingLeft: 8 + depth * 12 }}
              onClick={() => toggleCollapsed(g.id)}
            >
              <span className="tree-group-title name">
                <span className="chevron">{isCollapsed ? '▸' : '▾'}</span> 📁 {g.name}
              </span>
            </div>
            {!isCollapsed && (
              <>
                {hostsOf(g.id).map((h) => renderHost(h, 20 + depth * 12, colour))}
                {renderGroups(g.id, depth + 1, colour)}
              </>
            )}
          </div>
        )
      })
  }

  function renderHost(host: SessionProfile, paddingLeft: number, colour?: string): JSX.Element {
    const dotColour = host.color ?? colour
    return (
      <div
        className="tree-item"
        key={host.id}
        style={{ paddingLeft }}
        onDoubleClick={() => connect(host, dotColour)}
        onContextMenu={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setMenu({ x: e.clientX, y: e.clientY, items: hostMenu(host, dotColour) })
        }}
      >
        <span className="name" onClick={() => connect(host, dotColour)}>
          <span
            className="session-dot"
            style={dotColour ? { background: dotColour } : undefined}
            aria-hidden="true"
          />
          {host.name}
          {overrides.some((o) => o.hostId === host.id) && (
            <span className="no-inherit" title="Has a local override">
              ✎
            </span>
          )}
        </span>
        <span className="size">{host.host}</span>
      </div>
    )
  }

  return (
    <>
      <div className="sidebar-header" style={{ borderTop: 'none' }}>
        <button className="primary" style={{ flex: 1 }} onClick={() => setEditing('new')}>
          + Repository
        </button>
        <button
          className="icon-button"
          title="Sync all sources"
          disabled={sources.length === 0 || syncing.length > 0}
          onClick={() => syncInventory()}
        >
          <RefreshIcon />
        </button>
      </div>

      <div className="sidebar-tree">
        {!gitAvailable && (
          <div className="inventory-warning">
            git was not found on this machine. Install it (or add it to PATH) to sync inventories.
          </div>
        )}

        {sources.length === 0 && (
          <div style={{ padding: 12, color: 'var(--text-dim)', fontSize: 12, lineHeight: 1.5 }}>
            No repositories yet. Add one to pull an Ansible inventory and get its hosts here.
          </div>
        )}

        {sources.map((source) => {
          const rootId = `inv:${source.id}:root`
          const isCollapsed = needle === '' && collapsed.has(rootId)
          const busy = syncing.includes(source.id)
          return (
            <div className="tree-group" key={source.id}>
              <div
                className="tree-item"
                onClick={() => toggleCollapsed(rootId)}
                onContextMenu={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  setMenu({ x: e.clientX, y: e.clientY, items: sourceMenu(source) })
                }}
              >
                <span className="tree-group-title name">
                  <span className="chevron">{isCollapsed ? '▸' : '▾'}</span>
                  <span
                    className="session-dot"
                    style={source.color ? { background: source.color } : undefined}
                    aria-hidden="true"
                  />
                  {source.name}
                </span>
                <div className="actions">
                  <button
                    className="icon-button"
                    title="Sync now"
                    disabled={busy}
                    onClick={(e) => {
                      e.stopPropagation()
                      syncInventory(source.id)
                    }}
                  >
                    {busy ? '…' : <RefreshIcon />}
                  </button>
                </div>
              </div>

              <div className="inventory-meta" style={{ paddingLeft: 26 }}>
                {busy ? 'syncing…' : ago(source.lastSyncedAt)}
                {source.lastRevision ? ` · ${source.lastRevision}` : ''}
              </div>
              {source.lastError && (
                <div className="inventory-error" style={{ paddingLeft: 26 }}>
                  {source.lastError}
                </div>
              )}

              {!isCollapsed && (
                <>
                  {hostsOf(rootId).map((h) => renderHost(h, 20, source.color))}
                  {renderGroups(rootId, 1, source.color)}
                </>
              )}
            </div>
          )
        })}
      </div>

      {editing !== undefined && (
        <InventorySourceDialog
          initial={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(undefined)}
        />
      )}
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />
      )}
    </>
  )
}
