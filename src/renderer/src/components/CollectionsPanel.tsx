import { useEffect, useRef, useState } from 'react'
import type { DragEvent as ReactDragEvent } from 'react'
import type { HostCollection } from '../../../shared/types'
import { useStore, collectConnectedSessionIds, allRoots } from '../state/store'
import { colorOf, findHost } from '../state/hosts'
import { DEFAULT_PROTOCOL, protocolOf, type Protocol } from '../../../shared/protocols'
import { DesktopIcon, TerminalIcon } from './icons'
import ContextMenu, { type MenuItem } from './ContextMenu'
import { useT } from '../i18n'
import CollectionDialog from './CollectionDialog'
import { Chevron, TreeChildren, togglesFolder } from './TreeToggle'
import { TREE_HOST_NUDGE } from './treeIndent'
import { HOSTS_MIME } from '../state/dnd'
import { SectionHeading, type SectionControls } from './TreeSection'
import { currentPlace, returnTo, type Place } from '../state/clickPlace'

const COLLAPSED_KEY = 'terminaldeck.collapsedCollections'
/** A set's own row sits here; its hosts hang from a branch below its arrow. */
const COLLECTION_INDENT = 8

function loadCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY)
    return new Set(raw ? (JSON.parse(raw) as string[]) : [])
  } catch {
    return new Set()
  }
}

export default function CollectionsPanel({
  query,
  fold = null,
  section
}: {
  query: string
  /** The tree's "expand all" or "collapse all", stamped so a repeat still acts. */
  fold?: { open: boolean; at: number } | null
  /** Folding the whole section and moving it — see TreeSection. */
  section?: SectionControls
}): JSX.Element {
  const t = useT()
  const collections = useStore((s) => s.collections)
  const loadCollections = useStore((s) => s.loadCollections)
  const removeCollection = useStore((s) => s.removeCollection)
  const moveCollection = useStore((s) => s.moveCollection)
  const removeFromCollection = useStore((s) => s.removeFromCollection)
  const addToCollection = useStore((s) => s.addToCollection)
  const openCollection = useStore((s) => s.openCollection)
  const openHost = useStore((s) => s.openHost)
  const revealSession = useStore((s) => s.revealSession)
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
  const settings = useStore((s) => s.settings)
  /** The open menu, and the row it belongs to — marked while it stands. */
  const [menu, setMenu] = useState<{
    x: number
    y: number
    items: MenuItem[]
    forId?: string
  } | null>(null)

  /** Where a member's first click found the window — see `state/clickPlace`. */
  const clickedFrom = useRef<Place | null>(null)
  /** The set a host or folder from the tree is being held over. */
  const [dropOn, setDropOn] = useState<string | null>(null)

  useEffect(() => {
    loadCollections()
  }, [loadCollections])

  /**
   * A set takes whatever the tree drags onto it — a host, the ticked hosts it
   * is one of, or every host in a folder — anywhere over the set: its row or
   * the hosts listed under it, not a strip that has to be aimed for.
   */
  function allowHostsDrop(e: ReactDragEvent, collectionId: string): void {
    if (!e.dataTransfer.types.includes(HOSTS_MIME)) return
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'copy'
    if (dropOn !== collectionId) setDropOn(collectionId)
  }

  function leaveHostsDrop(e: ReactDragEvent, collectionId: string): void {
    // Moving between the rows inside the set is not leaving it.
    if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return
    setDropOn((cur) => (cur === collectionId ? null : cur))
  }

  async function dropHosts(e: ReactDragEvent, collectionId: string): Promise<void> {
    e.preventDefault()
    e.stopPropagation()
    setDropOn(null)
    const raw = e.dataTransfer.getData(HOSTS_MIME)
    if (!raw) return
    const hostIds = JSON.parse(raw) as string[]
    if (hostIds.length === 0) return
    await addToCollection(collectionId, hostIds)
    // Opened, so what just went in is seen going in.
    if (collapsed.has(collectionId)) toggleCollapsed(collectionId)
  }

  useEffect(() => {
    if (!fold) return
    const next = new Set(fold.open ? [] : useStore.getState().collections.map((c) => c.id))
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]))
    setCollapsed(next)
  }, [fold])

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
    protocol: Protocol
    missing: boolean
  }> {
    return collection.hostIds.map((id) => {
      const found = findHost(useStore.getState(), id)
      if (!found) return { id, name: id, protocol: DEFAULT_PROTOCOL, missing: true }
      return {
        id,
        name: found.host.name,
        address: found.host.host,
        // Seen through this collection, so it wears this collection's colour.
        color: colorOf(found.host, collection),
        protocol: protocolOf(found.host),
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
        <SectionHeading section={section} title={t('Collections')}>
          <button
            className="icon-button"
            title={t('New collection')}
            onClick={() => setEditing('new')}
          >
            +
          </button>
        </SectionHeading>

        {!section?.folded && (
          <>
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
                <div
                  className="tree-group"
                  key={collection.id}
                  onDragOver={(e) => allowHostsDrop(e, collection.id)}
                  onDragLeave={(e) => leaveHostsDrop(e, collection.id)}
                  onDrop={(e) => void dropHosts(e, collection.id)}
                >
                  <div
                    className={`tree-item${menu?.forId === collection.id ? ' menu-open' : ''}${
                      dropOn === collection.id ? ' drop-target' : ''
                    }`}
                    style={{ paddingLeft: COLLECTION_INDENT }}
                    onClick={(e) => {
                      if (togglesFolder(e, settings.expandOnArrowOnly))
                        toggleCollapsed(collection.id)
                    }}
                    onDoubleClick={() => openCollection(collection.id)}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      setMenu({
                        x: e.clientX,
                        y: e.clientY,
                        items: collectionMenu(collection),
                        forId: collection.id
                      })
                    }}
                    title={t('Double-click to open the whole set in a new workspace')}
                  >
                    <span className={`tree-group-title name ${isCollapsed ? '' : 'open'}`}>
                      <Chevron open={!isCollapsed} />
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

                  {!isCollapsed && (
                    <TreeChildren indent={COLLECTION_INDENT}>
                      {members.map((m) => (
                        <div
                          key={m.id}
                          className={`tree-item${
                            menu?.forId === `${collection.id}/${m.id}` ? ' menu-open' : ''
                          }`}
                          // Past the branch drawn to it, like a host in the Sessions tree.
                          style={{ paddingLeft: COLLECTION_INDENT + TREE_HOST_NUDGE }}
                          title={m.missing ? undefined : t('Double-click to connect')}
                          onClick={(e) => {
                            // The second click of a double-click opens; it does not
                            // move on to the next place the host is open in.
                            if (e.detail > 1) return
                            clickedFrom.current = currentPlace()
                            revealSession(m.id)
                          }}
                          onDoubleClick={() => {
                            if (!m.missing) {
                              returnTo(clickedFrom.current)
                              // Opened from here, so this set lends its look. Not
                              // always a new tab: see `openHost`.
                              openHost(
                                m.name,
                                { kind: 'session', sessionId: m.id },
                                m.color,
                                collection.id,
                                false,
                                true
                              )
                            }
                          }}
                          onContextMenu={(e) => {
                            e.preventDefault()
                            e.stopPropagation()
                            setMenu({
                              x: e.clientX,
                              y: e.clientY,
                              forId: `${collection.id}/${m.id}`,
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
                              className={`session-kind ${connected.has(m.id) ? 'live' : ''}`}
                              title={
                                connected.has(m.id)
                                  ? t('Open now')
                                  : m.protocol === 'rdp'
                                    ? t('Opens a desktop')
                                    : t('Opens a terminal')
                              }
                            >
                              {m.protocol === 'rdp' ? <DesktopIcon /> : <TerminalIcon />}
                            </span>
                            {m.missing ? (
                              <span style={{ color: 'var(--text-dim)' }}>
                                {t('{name} — no longer exists', { name: m.name })}
                              </span>
                            ) : (
                              m.name
                            )}
                          </span>
                        </div>
                      ))}
                    </TreeChildren>
                  )}
                </div>
              )
            })}
          </>
        )}
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
