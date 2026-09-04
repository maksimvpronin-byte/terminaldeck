import { useEffect, useState } from 'react'
import type { HostCollection } from '../../../shared/types'
import { useStore, collectConnectedSessionIds, allRoots } from '../state/store'
import { colorOf, findHost } from '../state/hosts'
import ContextMenu, { type MenuItem } from './ContextMenu'
import { useT } from '../i18n'
import CollectionDialog from './CollectionDialog'

const COLLAPSED_KEY = 'terminaldeck.collapsedCollections'

function loadCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY)
    return new Set(raw ? (JSON.parse(raw) as string[]) : [])
  } catch {
    return new Set()
  }
}

export default function CollectionsPanel({ query }: { query: string }): JSX.Element {
  const t = useT()
  const collections = useStore((s) => s.collections)
  const loadCollections = useStore((s) => s.loadCollections)
  const removeCollection = useStore((s) => s.removeCollection)
  const moveCollection = useStore((s) => s.moveCollection)
  const removeFromCollection = useStore((s) => s.removeFromCollection)
  const openCollection = useStore((s) => s.openCollection)
  const openTab = useStore((s) => s.openTab)
  const openMany = useStore((s) => s.openMany)
  const workspaces = useStore((s) => s.workspaces)
  // Subscribed to purely so the list redraws when a member is renamed, deleted
  // or arrives from a sync; the lookup itself goes through getState below.
  useStore((s) => s.sessions)
  useStore((s) => s.inventoryTrees)
  useStore((s) => s.inventoryOverrides)
  useStore((s) => s.gitFolderTrees)
  useStore((s) => s.gitFolderOverrides)

  const [editing, setEditing] = useState<HostCollection | 'new' | undefined>(undefined)
  const [collapsed, setCollapsed] = useState<Set<string>>(loadCollapsed)
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)

  useEffect(() => {
    loadCollections()
  }, [loadCollections])

  const connected = new Set(allRoots({ workspaces }).flatMap(collectConnectedSessionIds))
  const needle = query.trim().toLowerCase()

  function toggleCollapsed(id: string): void {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]))
      return next
    })
  }

  /**
   * Members resolved against both trees. A member that no longer resolves is
   * kept and flagged rather than dropped: a machine disappearing from an
   * inventory is exactly the kind of thing worth noticing.
   */
  function membersOf(collection: HostCollection): Array<{
    id: string
    name: string
    address?: string
    color?: string
    missing: boolean
  }> {
    return collection.hostIds.map((id) => {
      const found = findHost(useStore.getState(), id)
      if (!found) return { id, name: id, missing: true }
      return {
        id,
        name: found.host.name,
        address: found.host.host,
        // Seen through this collection, so it wears this collection's colour.
        color: colorOf(found.host, collection),
        missing: false
      }
    })
  }

  function collectionMenu(collection: HostCollection): MenuItem[] {
    const live = collection.hostIds.filter((id) => findHost(useStore.getState(), id)).length
    return [
      {
        label: t('Open in a new workspace ({count})', { count: live }),
        disabled: live === 0,
        onSelect: () => openCollection(collection.id)
      },
      {
        label: t('Open tiled in one tab'),
        disabled: live === 0,
        onSelect: () => {
          const items = collection.hostIds
            .map((id) => findHost(useStore.getState(), id))
            .filter((f): f is NonNullable<typeof f> => Boolean(f))
            .map((f) => ({
              title: f.host.name,
              target: { kind: 'session' as const, sessionId: f.host.id },
              color: colorOf(f.host, collection),
              viaCollectionId: collection.id
            }))
          openMany(items, 'grid')
        }
      },
      { label: t('Edit…'), separated: true, onSelect: () => setEditing(collection) },
      {
        label: t('Move up'),
        disabled: collections.indexOf(collection) === 0,
        onSelect: () => moveCollection(collection.id, -1)
      },
      {
        label: t('Move down'),
        disabled: collections.indexOf(collection) === collections.length - 1,
        onSelect: () => moveCollection(collection.id, 1)
      },
      {
        label: t('Delete collection'),
        danger: true,
        separated: true,
        onSelect: () => removeCollection(collection.id)
      }
    ]
  }

  const visible = needle
    ? collections.filter(
        (c) =>
          c.name.toLowerCase().includes(needle) ||
          membersOf(c).some((m) => `${m.name} ${m.address ?? ''}`.toLowerCase().includes(needle))
      )
    : collections

  return (
    <>
      <div className="tree-group">
        <div className="tree-group-title collections-heading">
          <span>{t('Collections')}</span>
          <button
            className="icon-button"
            title={t('New collection')}
            onClick={() => setEditing('new')}
          >
            +
          </button>
        </div>

        {collections.length === 0 && (
          <div
            style={{
              padding: '4px 12px 8px',
              color: 'var(--text-dim)',
              fontSize: 11,
              lineHeight: 1.5
            }}
          >
            {t('Your own sets of hosts, across any groups. Tick hosts above and press')}
            <strong> {t('Collect')}</strong>
            {t(', or right-click a workspace and save it here.')}
          </div>
        )}

        {visible.map((collection) => {
          const isCollapsed = needle === '' && collapsed.has(collection.id)
          const members = membersOf(collection)
          const missing = members.filter((m) => m.missing).length
          return (
            <div className="tree-group" key={collection.id}>
              <div
                className="tree-item"
                style={{ paddingLeft: 8 }}
                onClick={() => toggleCollapsed(collection.id)}
                onDoubleClick={() => openCollection(collection.id)}
                onContextMenu={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  setMenu({ x: e.clientX, y: e.clientY, items: collectionMenu(collection) })
                }}
                title={t('Double-click to open the whole set in a new workspace')}
              >
                <span className="tree-group-title name">
                  <span className="chevron">{isCollapsed ? '▸' : '▾'}</span>
                  <span
                    className="session-dot"
                    style={collection.color ? { background: collection.color } : undefined}
                    aria-hidden="true"
                  />
                  {collection.name}
                </span>
                <div className="actions">
                  <button
                    title={t('Open every host in a new workspace')}
                    onClick={(e) => {
                      e.stopPropagation()
                      openCollection(collection.id)
                    }}
                  >
                    {t('Open')}
                  </button>
                </div>
              </div>

              <div className="inventory-meta" style={{ paddingLeft: 34 }}>
                {t('Hosts: {count}', { count: members.length })}
                {missing > 0 ? t(' · {count} missing', { count: missing }) : ''}
              </div>

              {!isCollapsed &&
                members.map((m) => (
                  <div
                    key={m.id}
                    className="tree-item"
                    style={{ paddingLeft: 28 }}
                    title={m.missing ? undefined : t('Double-click to connect')}
                    onDoubleClick={() => {
                      if (!m.missing) {
                        // Opened from here, so this set lends its look.
                        openTab(
                          m.name,
                          { kind: 'session', sessionId: m.id },
                          m.color,
                          collection.id
                        )
                      }
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      setMenu({
                        x: e.clientX,
                        y: e.clientY,
                        items: [
                          {
                            label: t('Remove from collection'),
                            danger: true,
                            onSelect: () => removeFromCollection(collection.id, m.id)
                          }
                        ]
                      })
                    }}
                  >
                    <span className="name">
                      <span
                        className="session-dot"
                        style={m.color ? { background: m.color } : undefined}
                        aria-hidden="true"
                      />
                      {m.missing ? (
                        <span style={{ color: 'var(--text-dim)' }}>
                          {t('{name} — no longer exists', { name: m.name })}
                        </span>
                      ) : (
                        m.name
                      )}
                      {connected.has(m.id) && <span className="live-dot" />}
                    </span>
                  </div>
                ))}
            </div>
          )
        })}
      </div>

      {editing !== undefined && (
        <CollectionDialog
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
