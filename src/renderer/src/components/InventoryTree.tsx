import { useEffect, useMemo, useState } from 'react'
import type { CSSProperties, MouseEvent as ReactMouseEvent } from 'react'
import type { InventorySource, SessionGroup, SessionProfile } from '../../../shared/types'
import { resolveAuth } from '../../../shared/authResolution'
import { applyOverride } from '../../../shared/overrides'
import { protocolOf } from '../../../shared/protocols'
import {
  useStore,
  collectConnectedSessionIds,
  activeTab as currentTab,
  allRoots
} from '../state/store'
import InventorySourceDialog from './InventorySourceDialog'
import InventoryOverrideDialog from './InventoryOverrideDialog'
import ContextMenu, { type MenuItem } from './ContextMenu'
import SettingsDialog, { type SettingsTab } from './SettingsDialog'
import MultiConnectDialog from './MultiConnectDialog'
import { connectMenuItems } from './connectMenu'
import { morphOpen } from './hostMorph'
import { paneTitle } from '../state/connect'
import { overridesByNode } from '../state/hosts'
import { useT } from '../i18n'
import { ago } from '../state/syncStatus'
import { DesktopIcon, RefreshIcon, TerminalIcon } from './icons'
import { groupIndent, hostIndent } from './treeIndent'
import { Chevron, FolderIcon, TreeChildren } from './TreeToggle'
import Hint from './Hint'

const COLLAPSED_KEY = 'terminaldeck.collapsedInventory'

function loadCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY)
    return new Set(raw ? (JSON.parse(raw) as string[]) : [])
  } catch {
    return new Set()
  }
}

export default function InventoryTree({ query }: { query: string }): JSX.Element {
  const t = useT()
  const sources = useStore((s) => s.inventorySources)
  const trees = useStore((s) => s.inventoryTrees)
  const overrides = useStore((s) => s.inventoryOverrides)
  const syncing = useStore((s) => s.inventorySyncing)
  const syncErrors = useStore((s) => s.inventorySyncErrors)
  const gitAvailable = useStore((s) => s.gitAvailable)
  const loadInventory = useStore((s) => s.loadInventory)
  const syncInventory = useStore((s) => s.syncInventory)
  const removeInventorySource = useStore((s) => s.removeInventorySource)
  const clearInventoryOverride = useStore((s) => s.clearInventoryOverride)
  const openTab = useStore((s) => s.openTab)
  const splitPaneWith = useStore((s) => s.splitPaneWith)
  const selectedHostIds = useStore((s) => s.selectedHostIds)
  const toggleHostSelection = useStore((s) => s.toggleHostSelection)
  const selectOnlyHost = useStore((s) => s.selectOnlyHost)
  const revealSession = useStore((s) => s.revealSession)
  const selectHostRange = useStore((s) => s.selectHostRange)
  const openMany = useStore((s) => s.openMany)
  const credentials = useStore((s) => s.credentials)
  const workspaces = useStore((s) => s.workspaces)
  const connected = new Set(allRoots({ workspaces }).flatMap(collectConnectedSessionIds))

  const [editing, setEditing] = useState<InventorySource | 'new' | undefined>(undefined)
  const [collapsed, setCollapsed] = useState<Set<string>>(loadCollapsed)
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  const [overriding, setOverriding] = useState<SessionProfile | SessionGroup | null>(null)
  /** Which page Settings should open on, or null while it is closed. */
  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(null)
  /** The host being opened several times over, once that has been asked for. */
  const [multiConnecting, setMultiConnecting] = useState<{
    id: string
    name: string
    color?: string
  } | null>(null)

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

  const needle = query.trim().toLowerCase()

  const overrideOf = useMemo(() => overridesByNode(overrides), [overrides])

  /** Local settings layered over a derived node, blank fields ignored. */
  function withOverride<T extends { id: string }>(node: T): T {
    return applyOverride(node, overrideOf.get(node.id))
  }

  // Groups carry overrides too, so a whole Ansible group can be pointed at a
  // different bastion or user without touching the repository.
  const allGroups = useMemo<SessionGroup[]>(
    () => trees.flatMap((tree) => tree.groups).map((g) => applyOverride(g, overrideOf.get(g.id))),
    [trees, overrideOf]
  )

  /**
   * The tree indexed once per change rather than searched once per row: a group
   * looked up its hosts by walking every host of every source, and its
   * subgroups by walking every group — for each group, on every redraw.
   */
  const childrenOf = useMemo(() => {
    const byParent = new Map<string | null, SessionGroup[]>()
    for (const g of allGroups) {
      const siblings = byParent.get(g.parentId)
      if (siblings) siblings.push(g)
      else byParent.set(g.parentId, [g])
    }
    return byParent
  }, [allGroups])

  /**
   * Hosts each group names. A host in several groups appears under each of
   * them — it is one host throughout, so selecting or colouring it in one place
   * shows everywhere. Older synced trees have no memberships; those fall back
   * to the single parent they were stored with.
   */
  const hostsByGroup = useMemo(() => {
    const byGroup = new Map<string, SessionProfile[]>()
    for (const tree of trees) {
      for (const raw of tree.sessions) {
        const host = applyOverride(raw, overrideOf.get(raw.id))
        for (const groupId of new Set(tree.memberships?.[raw.id] ?? [raw.groupId])) {
          if (groupId === null) continue
          const list = byGroup.get(groupId)
          if (list) list.push(host)
          else byGroup.set(groupId, [host])
        }
      }
    }
    return byGroup
  }, [trees, overrideOf])

  function hostsOf(groupId: string): SessionProfile[] {
    const hosts = hostsByGroup.get(groupId) ?? []
    return needle
      ? hosts.filter((h) => `${h.name} ${h.host}`.toLowerCase().includes(needle))
      : hosts
  }

  /** How many groups name this host, so the tree can point out the duplicates. */
  function membershipCount(hostId: string): number {
    for (const t of trees) {
      const claims = t.memberships?.[hostId]
      if (claims) return claims.length
    }
    return 1
  }

  /**
   * Groups holding a match somewhere below them, worked out once per search
   * rather than again for every group on the way down.
   */
  const matchingGroups = useMemo(() => {
    const found = new Map<string, boolean>()
    if (!needle) return found
    const visit = (groupId: string): boolean => {
      const known = found.get(groupId)
      if (known !== undefined) return known
      // Settled as "no" before looking down, so a loop in a broken tree ends.
      found.set(groupId, false)
      let match = (hostsByGroup.get(groupId) ?? []).some((h) =>
        `${h.name} ${h.host}`.toLowerCase().includes(needle)
      )
      for (const child of childrenOf.get(groupId) ?? []) {
        if (visit(child.id)) match = true
      }
      found.set(groupId, match)
      return match
    }
    for (const g of allGroups) visit(g.id)
    return found
  }, [needle, hostsByGroup, childrenOf, allGroups])

  function subtreeHasMatch(groupId: string): boolean {
    return matchingGroups.get(groupId) === true
  }

  /** What the last sync actually produced for a source, shown next to the revision. */
  function countsFor(sourceId: string): string {
    const tree = trees.find((candidate) => candidate.sourceId === sourceId)
    if (!tree) return t('not synced yet')
    const hosts = tree.sessions.length
    // The source itself is always one group, so it does not count as content.
    const groups = Math.max(0, tree.groups.length - 1)
    if (hosts === 0) return t('no hosts found')
    // Counted as "hosts: 3, groups: 1" rather than "3 hosts": one entry then
    // serves every number, in a language that declines the noun three ways.
    return t('hosts: {hosts}, groups: {groups}', { hosts, groups })
  }

  /**
   * Opens the host in a tab. An account named here applies to that tab alone;
   * an inventory host is read from a repository and nothing about this is
   * written back, to the repo or to the local override.
   */
  function connect(
    host: SessionProfile,
    colour?: string,
    credentialId?: string,
    admin?: boolean
  ): void {
    const credential = credentials.find((c) => c.id === credentialId)
    const title = paneTitle(host.name, credential)
    openTab(
      admin ? `${title} · ${t('console')}` : title,
      { kind: 'session', sessionId: host.id, credentialId, admin },
      colour
    )
  }

  function hostMenu(host: SessionProfile, atX: number, atY: number, colour?: string): MenuItem[] {
    const state = useStore.getState()
    const activeTab = currentTab(state)
    const auth = resolveAuth(host, host.groupId, allGroups)
    const overridden = overrides.some((o) => o.nodeId === host.id)
    return [
      { label: t('Connect'), onSelect: () => connect(host, colour) },
      {
        label: t('Connect in split'),
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
      ...connectMenuItems({
        t,
        credentials,
        connectAs: (credentialId) => connect(host, colour, credentialId),
        showMenu: (items) => setMenu({ x: atX, y: atY, items }),
        manageAccounts: () => setSettingsTab('accounts'),
        openMultiConnect: () => setMultiConnecting({ id: host.id, name: host.name, color: colour }),
        connectConsole:
          protocolOf(host) === 'rdp' ? () => connect(host, colour, undefined, true) : undefined
      }),
      {
        label: t('Copy {address}', {
          address: `${auth.username ? `${auth.username}@` : ''}${host.host}`
        }),
        separated: true,
        onSelect: () =>
          window.td.clipboard.write(`${auth.username ? `${auth.username}@` : ''}${host.host}`)
      },
      {
        label: overridden ? t('Local settings…') : t('Override locally…'),
        separated: true,
        onSelect: () => setOverriding(host)
      },
      {
        label: t('Clear local override'),
        disabled: !overridden,
        onSelect: () => clearInventoryOverride(host.id)
      }
    ]
  }

  /**
   * Every host under a group, including its nested groups, each listed once
   * however many of those groups happen to name it.
   */
  function hostsUnder(groupId: string): SessionProfile[] {
    const ids = new Set([groupId])
    let grew = true
    while (grew) {
      grew = false
      for (const g of allGroups) {
        if (g.parentId && ids.has(g.parentId) && !ids.has(g.id)) {
          ids.add(g.id)
          grew = true
        }
      }
    }
    const out = new Map<string, SessionProfile>()
    for (const t of trees) {
      for (const h of t.sessions) {
        const claims = t.memberships?.[h.id] ?? (h.groupId ? [h.groupId] : [])
        if (claims.some((g) => ids.has(g))) out.set(h.id, withOverride(h))
      }
    }
    return [...out.values()]
  }

  function groupMenu(group: SessionGroup): MenuItem[] {
    const overridden = overrides.some((o) => o.nodeId === group.id)
    const hosts = hostsUnder(group.id)
    return [
      {
        label: `Open all in a new workspace (${hosts.length})`,
        disabled: hosts.length === 0,
        onSelect: () =>
          openMany(
            hosts.map((h) => ({
              title: h.name,
              target: { kind: 'session' as const, sessionId: h.id },
              color: h.color
            })),
            'workspace',
            group.name
          )
      },
      {
        label: overridden ? t('Local settings…') : t('Override locally…'),
        separated: true,
        onSelect: () => setOverriding(group)
      },
      {
        label: t('Clear local settings'),
        disabled: !overridden,
        onSelect: () => clearInventoryOverride(group.id)
      }
    ]
  }

  function sourceMenu(source: InventorySource): MenuItem[] {
    const hosts = hostsUnder(`inv:${source.id}:root`)
    return [
      {
        label: `Open all in a new workspace (${hosts.length})`,
        disabled: hosts.length === 0,
        onSelect: () =>
          openMany(
            hosts.map((h) => ({
              title: h.name,
              target: { kind: 'session' as const, sessionId: h.id },
              color: h.color ?? source.color
            })),
            'workspace',
            source.name
          )
      },
      { label: t('Sync now'), separated: true, onSelect: () => syncInventory(source.id) },
      { label: t('Edit…'), onSelect: () => setEditing(source) },
      {
        label: t('Remove source'),
        danger: true,
        separated: true,
        onSelect: () => removeInventorySource(source.id)
      }
    ]
  }

  function renderGroups(parentId: string, depth: number, colour?: string): JSX.Element[] {
    return (childrenOf.get(parentId) ?? [])
      .filter((g) => !needle || subtreeHasMatch(g.id))
      .map((g) => {
        const isCollapsed = needle === '' && collapsed.has(g.id)
        return (
          <div className="tree-group" key={g.id}>
            <div
              className="tree-item"
              style={{ paddingLeft: groupIndent(depth) }}
              onClick={() => toggleCollapsed(g.id)}
              onContextMenu={(e) => {
                e.preventDefault()
                e.stopPropagation()
                setMenu({ x: e.clientX, y: e.clientY, items: groupMenu(g) })
              }}
            >
              <span className={`tree-group-title name ${isCollapsed ? '' : 'open'}`}>
                <Chevron open={!isCollapsed} /> <FolderIcon open={!isCollapsed} /> {g.name}
                {overrides.some((o) => o.nodeId === g.id) && (
                  <span className="no-inherit" title={t('Has local settings')}>
                    ✎
                  </span>
                )}
              </span>
            </div>
            {!isCollapsed && (
              <TreeChildren indent={groupIndent(depth)}>
                {hostsOf(g.id).map((h) => renderHost(h, hostIndent(depth), colour))}
                {renderGroups(g.id, depth + 1, colour)}
              </TreeChildren>
            )}
          </div>
        )
      })
  }

  /** Ids in on-screen order, so Shift-click can take a range. */
  function flattenOrder(parentId: string): string[] {
    const out: string[] = [...hostsOf(parentId).map((h) => h.id)]
    for (const g of childrenOf.get(parentId) ?? []) {
      if (needle === '' && collapsed.has(g.id)) continue
      out.push(...flattenOrder(g.id))
    }
    // A host shown under two groups would otherwise appear twice here, and a
    // Shift-click range would stop at whichever copy came first.
    return [...new Set(out)]
  }

  function onHostClick(e: ReactMouseEvent, host: SessionProfile): void {
    if (e.metaKey || e.ctrlKey) {
      toggleHostSelection(host.id)
      return
    }
    if (e.shiftKey) {
      const order = sources.flatMap((s) => flattenOrder(`inv:${s.id}:root`))
      selectHostRange(order, host.id)
      return
    }
    // Matches the saved-sessions tree: a plain click selects, and shows the host
    // if it is already open; connecting is a double-click.
    selectOnlyHost(host.id)
    revealSession(host.id)
  }

  function renderHost(host: SessionProfile, paddingLeft: number, colour?: string): JSX.Element {
    const rowColour = host.color ?? colour
    const Kind = protocolOf(host) === 'rdp' ? DesktopIcon : TerminalIcon
    return (
      <div
        className={`tree-item ${rowColour ? 'tinted' : ''} ${
          selectedHostIds.includes(host.id) ? 'selected' : ''
        }`}
        key={host.id}
        data-host-id={host.id}
        style={
          { paddingLeft, ...(rowColour ? { '--host-colour': rowColour } : {}) } as CSSProperties
        }
        onClick={(e) => onHostClick(e, host)}
        onDoubleClick={(e) => {
          const row = e.currentTarget
          connect(host, rowColour)
          morphOpen(row, currentTab(useStore.getState())?.id, {
            title: host.name,
            colour: rowColour
          })
        }}
        title={t('Double-click to connect')}
        onContextMenu={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setMenu({
            x: e.clientX,
            y: e.clientY,
            items: hostMenu(host, e.clientX, e.clientY, rowColour)
          })
        }}
      >
        <span className="name">
          <span
            className={`session-kind ${connected.has(host.id) ? 'live' : ''}`}
            title={
              connected.has(host.id)
                ? t('Open now')
                : protocolOf(host) === 'rdp'
                  ? t('Opens a desktop')
                  : t('Opens a terminal')
            }
          >
            <Kind />
          </span>
          {host.name}
          {membershipCount(host.id) > 1 && (
            <span
              className="no-inherit"
              title={t(
                'In {count} groups — the same host, shown under each. Its connection settings come from {group}.',
                {
                  count: membershipCount(host.id),
                  group: allGroups.find((g) => g.id === host.groupId)?.name ?? t('its group')
                }
              )}
            >
              ×{membershipCount(host.id)}
            </span>
          )}
          {overrides.some((o) => o.nodeId === host.id) && (
            <span className="no-inherit" title={t('Has a local override')}>
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
          + {t('Repository')}
        </button>
        <button
          className="icon-button"
          title={t('Sync all sources')}
          disabled={sources.length === 0 || syncing.length > 0}
          onClick={() => syncInventory()}
        >
          <RefreshIcon />
        </button>
      </div>

      <div className="sidebar-tree">
        {!gitAvailable && (
          <div className="inventory-warning">
            {t(
              'git was not found on this machine. Install it (or add it to PATH) to sync inventories.'
            )}
          </div>
        )}

        {sources.length === 0 && (
          <div style={{ padding: 12, color: 'var(--text-dim)', fontSize: 12, lineHeight: 1.5 }}>
            {t('No repositories yet. Add one to pull an Ansible inventory and get its hosts here.')}
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
                style={{ paddingLeft: groupIndent(0) }}
                onClick={() => toggleCollapsed(rootId)}
                onContextMenu={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  setMenu({ x: e.clientX, y: e.clientY, items: sourceMenu(source) })
                }}
              >
                <span className={`tree-group-title name ${isCollapsed ? '' : 'open'}`}>
                  <Chevron open={!isCollapsed} />
                  <span
                    className="session-dot"
                    style={source.color ? { background: source.color } : undefined}
                    aria-hidden="true"
                  />
                  {source.name}
                  {/* Branch, revision, counts and files together say which step
                      of a sync went wrong — every one of those failures looks
                      identical from the outside otherwise: a sync that reports
                      success and leaves the hosts exactly as they were. Worth
                      keeping and not worth four lines under every repository in
                      the list, which is what it was. */}
                  <Hint>
                    <div>
                      {ago(t, source.lastSyncedAt)}
                      {` · ${source.branch || t('default branch')}`}
                      {source.lastRevision ? ` · ${source.lastRevision}` : ''}
                      {` · ${countsFor(source.id)}`}
                    </div>
                    {source.lastFiles && (
                      <div>
                        {t('read {count} files', { count: source.lastFiles.length })}
                        {source.lastFiles.length > 0 ? `: ${source.lastFiles.join(', ')}` : ''}
                      </div>
                    )}
                  </Hint>
                </span>
                <div className="actions">
                  <button
                    className="icon-button"
                    title={t('Sync now')}
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

              {/* While a sync is running, and only then. It is the one state
                  worth interrupting the list for: everything else about a
                  repository is under the mark beside its name. */}
              {busy && (
                <div className="inventory-meta" style={{ paddingLeft: hostIndent(0) }}>
                  {t('syncing…')}
                </div>
              )}
              {(source.lastError || syncErrors[source.id]) && (
                <div className="inventory-error" style={{ paddingLeft: hostIndent(0) }}>
                  {source.lastError ?? syncErrors[source.id]}
                </div>
              )}

              {!isCollapsed && (
                <TreeChildren indent={groupIndent(0)}>
                  {hostsOf(rootId).map((h) => renderHost(h, hostIndent(0), source.color))}
                  {renderGroups(rootId, 1, source.color)}
                </TreeChildren>
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
      {overriding && (
        <InventoryOverrideDialog
          node={overriding}
          groups={allGroups}
          onClose={() => setOverriding(null)}
        />
      )}
      {settingsTab && (
        <SettingsDialog initialTab={settingsTab} onClose={() => setSettingsTab(null)} />
      )}
      {multiConnecting && (
        <MultiConnectDialog host={multiConnecting} onClose={() => setMultiConnecting(null)} />
      )}
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />
      )}
    </>
  )
}
