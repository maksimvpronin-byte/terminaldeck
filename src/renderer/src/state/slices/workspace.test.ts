// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { useStore } from '../store'
import { collectLeaves, makeLeaf, monitorShown } from '../paneTree'
import type { SessionGroup, SessionProfile } from '../../../../shared/types'

describe('reorderTab', () => {
  function seed(): void {
    const leaf = (id: string): ReturnType<typeof makeLeaf> => ({
      ...makeLeaf(id, { kind: 'session', sessionId: id }),
      id
    })
    const tab = (id: string) => ({ id, title: id, root: leaf(id), activePaneId: id })
    useStore.setState({
      activeWorkspaceId: 'w',
      workspaces: [
        { id: 'w', title: 'work', activeTabId: 'b', tabs: ['a', 'b', 'c'].map(tab) },
        { id: 'x', title: 'other', activeTabId: 'd', tabs: [tab('d')] }
      ]
    })
  }
  const order = (i = 0): string[] => useStore.getState().workspaces[i].tabs.map((t) => t.id)

  it('drops a tab into the gap before or after another, keeping the same tab objects', () => {
    seed()
    const before = useStore.getState().workspaces[0].tabs
    useStore.getState().reorderTab('c', 'a', 'before')
    expect(order()).toEqual(['c', 'a', 'b'])
    useStore.getState().reorderTab('c', 'b', 'after')
    expect(order()).toEqual(['a', 'b', 'c'])
    useStore.getState().reorderTab('a', 'b', 'after')
    expect(order()).toEqual(['b', 'a', 'c'])
    // Same objects, so no panel remounts and no connection drops.
    const after = useStore.getState().workspaces[0].tabs
    expect(new Set(after)).toEqual(new Set(before))
    expect(useStore.getState().workspaces[0].activeTabId).toBe('b')
  })

  it('leaves the state alone for no-op drops and tabs in another workspace', () => {
    seed()
    const workspaces = useStore.getState().workspaces
    useStore.getState().reorderTab('a', 'b', 'before')
    useStore.getState().reorderTab('b', 'b', 'after')
    useStore.getState().reorderTab('d', 'a', 'before')
    useStore.getState().reorderTab('missing', 'a', 'before')
    expect(useStore.getState().workspaces).toBe(workspaces)
  })
})

describe('terminal activity', () => {
  it('notifies once for unread output and never for visible, already marked or missing tabs', () => {
    const root = makeLeaf('host', { kind: 'session', sessionId: 'host' })
    useStore.setState({
      activeWorkspaceId: 'w',
      workspaces: [
        {
          id: 'w',
          title: 'work',
          activeTabId: 'a',
          tabs: [
            { id: 'a', title: 'a', root, activePaneId: root.id },
            { id: 'b', title: 'b', root: { ...root, id: 'other' }, activePaneId: 'other' }
          ]
        }
      ]
    })
    const notified = vi.fn()
    const off = useStore.subscribe(notified)
    const { markActivity } = useStore.getState()
    for (let i = 0; i < 1000; i++) {
      markActivity('a')
      markActivity('missing')
    }
    expect(notified).not.toHaveBeenCalled()
    for (let i = 0; i < 1000; i++) markActivity('b')
    expect(notified).toHaveBeenCalledTimes(1)
    expect(useStore.getState().workspaces[0].tabs[1].hasActivity).toBe(true)
    off()
  })
})

/**
 * Dropping a tab onto a pane took the first pane of it and closed the rest:
 * every other pane of a split tab vanished, and its session was closed.
 */
describe('dropping a split tab onto a pane', () => {
  function seed(): void {
    const leaf = (id: string): ReturnType<typeof makeLeaf> => ({
      ...makeLeaf(id, { kind: 'session', sessionId: id }),
      id,
      connectionId: `conn-${id}`
    })
    useStore.setState({
      activeWorkspaceId: 'w',
      workspaces: [
        {
          id: 'w',
          title: 'work',
          activeTabId: 'target',
          tabs: [
            { id: 'target', title: 'target', root: leaf('t'), activePaneId: 't' },
            {
              id: 'source',
              title: 'source',
              root: {
                type: 'split',
                id: 'split',
                dir: 'row',
                sizes: [30, 70],
                children: [leaf('first'), leaf('second')]
              },
              // Not the first pane: the one in use must stay the one in use.
              activePaneId: 'second'
            }
          ]
        }
      ]
    })
  }

  it('brings every pane, in its layout, and keeps the one in use active', () => {
    seed()
    useStore.getState().mergeTabInto('source', 'target', 't', 'col', 'after')

    const tabs = useStore.getState().workspaces[0].tabs
    expect(tabs.map((t) => t.id)).toEqual(['target'])
    const [target] = tabs
    expect(target.root.type).toBe('split')
    if (target.root.type !== 'split') return
    const moved = target.root.children[1]
    expect(moved.type).toBe('split')
    if (moved.type !== 'split') return
    expect(moved.sizes).toEqual([30, 70])
    const [first, second] = moved.children
    expect([first, second].map((p) => p.type === 'leaf' && p.title)).toEqual(['first', 'second'])
    expect(target.activePaneId).toBe(second.id)
    // New panes, not the old ones still closing: new ids, no borrowed session.
    expect(second.id).not.toBe('second')
    expect(second.type === 'leaf' && second.connectionId).toBeUndefined()
  })

  it('leaves both tabs alone when the pane dropped on is not there', () => {
    seed()
    const before = useStore.getState().workspaces
    useStore.getState().mergeTabInto('source', 'target', 'missing', 'col', 'after')
    expect(useStore.getState().workspaces).toBe(before)
  })
})

/**
 * A collection lends its look to the panes opened from it. Opened as a grid,
 * only the first pane wore it: the rest were split in without it.
 */
describe('a collection opened as a grid', () => {
  it('gives every pane the collection it came from', () => {
    useStore.setState({ workspaces: [], activeWorkspaceId: null })
    useStore.getState().openMany(
      ['a', 'b', 'c'].map((id) => ({
        title: id,
        target: { kind: 'session' as const, sessionId: id },
        viaCollectionId: 'col1'
      })),
      'grid'
    )
    const [tab] = useStore.getState().workspaces[0].tabs
    expect(collectLeaves(tab.root).map((l) => l.viaCollectionId)).toEqual(['col1', 'col1', 'col1'])
  })

  it('keeps the look when a pane of it is split again', () => {
    useStore.setState({ workspaces: [], activeWorkspaceId: null })
    const paneId = useStore
      .getState()
      .openTab('a', { kind: 'session', sessionId: 'a' }, '#abcdef', 'col1')
    const tabId = useStore.getState().workspaces[0].tabs[0].id
    useStore.getState().splitPane(tabId, paneId, 'row')
    const [tab] = useStore.getState().workspaces[0].tabs
    expect(collectLeaves(tab.root).map((l) => [l.color, l.viaCollectionId])).toEqual([
      ['#abcdef', 'col1'],
      ['#abcdef', 'col1']
    ])
  })
})

describe('revealSession', () => {
  it('asks the pane it brings forward for the keyboard, and asks nothing when there is none', () => {
    useStore.setState({ workspaces: [], activeWorkspaceId: null, focusRequest: 0 })
    const paneId = useStore.getState().openTab('db', { kind: 'session', sessionId: 'db' })
    const tabId = useStore.getState().workspaces[0].tabs[0].id
    useStore.getState().setPaneConnection(tabId, paneId, 'conn-1')

    expect(useStore.getState().revealSession('db')).toBe(true)
    expect(useStore.getState().focusRequest).toBe(1)
    // The pane already in front is asked again: that is the click it answers.
    expect(useStore.getState().revealSession('db')).toBe(true)
    expect(useStore.getState().focusRequest).toBe(2)

    expect(useStore.getState().revealSession('nowhere')).toBe(false)
    expect(useStore.getState().focusRequest).toBe(2)
  })
})

it('preserves collection settings when a pane is detached', () => {
  useStore.setState({ workspaces: [], activeWorkspaceId: null })
  const paneId = useStore
    .getState()
    .openTab('host', { kind: 'session', sessionId: 'host' }, '#abcdef', 'collection')
  const tabId = useStore.getState().workspaces[0].tabs[0].id
  useStore.getState().splitPane(tabId, paneId, 'row')
  useStore.getState().detachPane(tabId, paneId)
  const moved = collectLeaves(useStore.getState().workspaces[0].tabs[1].root)[0]
  expect(moved.viaCollectionId).toBe('collection')
  expect(moved.color).toBe('#abcdef')
})

it('does not lose a tab moved to a workspace that no longer exists', () => {
  useStore.setState({ workspaces: [], activeWorkspaceId: null })
  useStore.getState().openTab('host', { kind: 'session', sessionId: 'host' })
  const before = useStore.getState().workspaces
  const tabId = before[0].tabs[0].id
  useStore.getState().moveTabToWorkspace(tabId, 'deleted-workspace')
  expect(useStore.getState().workspaces).toBe(before)
  expect(useStore.getState().activeWorkspaceId).toBe(before[0].id)
})

describe('openHost: an open host is brought forward rather than opened again', () => {
  const host = (id: string, protocol?: 'rdp'): SessionProfile => ({
    id,
    name: id,
    host: `${id}.example`,
    groupId: null,
    tags: [],
    logToFile: false,
    portForwards: [],
    createdAt: 0,
    updatedAt: 0,
    ...(protocol ? { protocol } : {})
  })
  function seed(reuseOpenHost = true): void {
    useStore.setState((s) => ({
      workspaces: [],
      activeWorkspaceId: null,
      wakeRequest: null,
      sessions: [host('web'), host('dc', 'rdp')],
      settings: { ...s.settings, reuseOpenHost }
    }))
  }
  const tabCount = (): number =>
    useStore.getState().workspaces.reduce((n, w) => n + w.tabs.length, 0)
  const open = (id: string, extra: Record<string, unknown> = {}, again = false): string =>
    useStore
      .getState()
      .openHost(id, { kind: 'session', sessionId: id, ...extra }, undefined, undefined, again)

  it('goes to the tab a terminal is already in, and asks it to connect if it has dropped', () => {
    seed()
    const first = open('web')
    open('dc')
    expect(open('web')).toBe(first)
    expect(tabCount()).toBe(2)
    expect(useStore.getState().wakeRequest).toEqual({ paneId: first, n: 1, reconnect: false })
    const tab = useStore.getState().workspaces[0].tabs.find((t) => t.activePaneId === first)
    expect(useStore.getState().workspaces[0].activeTabId).toBe(tab?.id)
  })

  it('asks a live pane to reconnect only for a double-click, with the setting on', () => {
    seed()
    const first = open('web')
    const again = (doubleClick: boolean): unknown => {
      useStore
        .getState()
        .openHost(
          'web',
          { kind: 'session', sessionId: 'web' },
          undefined,
          undefined,
          false,
          doubleClick
        )
      return useStore.getState().wakeRequest?.reconnect
    }
    expect(again(true)).toBe(false)
    useStore.setState((s) => ({ settings: { ...s.settings, reconnectOnDoubleClick: true } }))
    expect(again(false)).toBe(false)
    expect(again(true)).toBe(true)
    expect(useStore.getState().wakeRequest?.paneId).toBe(first)
  })

  it('opens another terminal when asked, when an account is chosen, or with the setting off', () => {
    seed()
    open('web')
    open('web', {}, true)
    open('web', { credentialId: 'admin' })
    expect(tabCount()).toBe(3)
    seed(false)
    open('web')
    open('web')
    expect(tabCount()).toBe(2)
  })

  it('never opens a second desktop for one account, setting or not, again or not', () => {
    seed(false)
    const first = open('dc')
    expect(open('dc')).toBe(first)
    expect(open('dc', {}, true)).toBe(first)
    expect(tabCount()).toBe(1)
    // Another account is another Windows session, and stands beside it.
    const other = open('dc', { credentialId: 'admin' })
    expect(other).not.toBe(first)
    expect(open('dc', { credentialId: 'admin' })).toBe(other)
    expect(tabCount()).toBe(2)
  })

  it('finds the host in another workspace and brings that workspace forward', () => {
    seed()
    const first = open('web')
    useStore.getState().openWorkspace('second')
    open('dc')
    expect(open('web')).toBe(first)
    const state = useStore.getState()
    expect(state.workspaces.find((w) => w.id === state.activeWorkspaceId)?.title).not.toBe('second')
  })

  describe('from a collection', () => {
    const set = {
      id: 'set',
      name: 'Set',
      hostIds: ['web', 'db'],
      createdAt: 0,
      updatedAt: 0
    }
    const fromSet = (id: string, again = false): string =>
      useStore.getState().openHost(id, { kind: 'session', sessionId: id }, '#f00', 'set', again)
    const titleOfActive = (): string | undefined => {
      const state = useStore.getState()
      return state.workspaces.find((w) => w.id === state.activeWorkspaceId)?.title
    }

    it("joins the set's workspace rather than the one in front", () => {
      seed(false)
      useStore.setState({ collections: [set], sessions: [host('web'), host('db')] })
      useStore.getState().openCollection('set')
      useStore.getState().openWorkspace('elsewhere')
      fromSet('web')
      expect(titleOfActive()).toBe('Set')
      const own = useStore.getState().workspaces.find((w) => w.title === 'Set')
      expect(own?.tabs).toHaveLength(3)
      expect(useStore.getState().workspaces.find((w) => w.title === 'elsewhere')?.tabs).toEqual([])
    })

    it('opens a workspace for the set when none is open, and reuses it after', () => {
      seed(false)
      useStore.setState({ collections: [set] })
      useStore.getState().openWorkspace('elsewhere')
      fromSet('web')
      fromSet('web')
      const own = useStore.getState().workspaces.filter((w) => w.collectionId === 'set')
      expect(own).toHaveLength(1)
      expect(own[0]).toMatchObject({ title: 'Set', color: '#f00' })
      expect(own[0].tabs).toHaveLength(2)
    })

    it('keeps a duplicate beside its original', () => {
      seed(false)
      useStore.setState({ collections: [set] })
      fromSet('web')
      useStore.getState().openWorkspace('elsewhere')
      fromSet('web', true)
      expect(titleOfActive()).toBe('elsewhere')
    })

    it('makes a workspace saved as the set its own, and only that one', () => {
      seed(false)
      useStore.setState({ collections: [set] })
      fromSet('web')
      const saved = useStore.getState().openWorkspace('saved')
      useStore.getState().setWorkspaceCollection(saved, 'set')
      useStore.getState().openWorkspace('elsewhere')
      fromSet('web')
      expect(titleOfActive()).toBe('saved')
      expect(useStore.getState().workspaces.filter((w) => w.collectionId === 'set')).toHaveLength(1)
    })
  })

  describe('from the tree', () => {
    const set = { id: 'set', name: 'Set', hostIds: ['web'], createdAt: 0, updatedAt: 0 }
    const titleOfActive = (): string | undefined => {
      const state = useStore.getState()
      return state.workspaces.find((w) => w.id === state.activeWorkspaceId)?.title
    }
    const tabsOf = (title: string): number | undefined =>
      useStore.getState().workspaces.find((w) => w.title === title)?.tabs.length

    it("stays out of a set's workspace in front, for the last ordinary one", () => {
      seed(false)
      useStore.setState({ collections: [set] })
      useStore.getState().openWorkspace('plain')
      useStore.getState().openCollection('set')
      expect(titleOfActive()).toBe('Set')
      open('db')
      expect(titleOfActive()).toBe('plain')
      expect(tabsOf('plain')).toBe(1)
      expect(tabsOf('Set')).toBe(1)
    })

    it('makes an ordinary workspace when every one is a set’s', () => {
      seed(false)
      useStore.setState({ collections: [set] })
      useStore.getState().openCollection('set')
      open('db')
      const state = useStore.getState()
      expect(state.workspaces).toHaveLength(2)
      expect(state.workspaces.find((w) => w.id === state.activeWorkspaceId)?.collectionId).toBe(
        undefined
      )
    })

    it('opens in the ordinary workspace in front, as before', () => {
      seed(false)
      useStore.getState().openWorkspace('one')
      useStore.getState().openWorkspace('two')
      open('web')
      expect(tabsOf('two')).toBe(1)
    })

    it('keeps a duplicate beside its original, even in a set’s workspace', () => {
      seed(false)
      useStore.setState({ collections: [set] })
      useStore.getState().openWorkspace('plain')
      useStore.getState().openCollection('set')
      open('web', {}, true)
      expect(titleOfActive()).toBe('Set')
    })

    describe('with a workspace per group', () => {
      const group = (id: string, color?: string): SessionGroup =>
        ({ id, name: id.toUpperCase(), parentId: null, color }) as SessionGroup
      function seedGroups(on = true): void {
        seed(false)
        useStore.setState((s) => ({
          groups: [group('tls', '#0a0'), group('dns')],
          sessions: [
            { ...host('a'), groupId: 'tls' },
            { ...host('b'), groupId: 'tls' },
            { ...host('c'), groupId: 'dns' },
            host('top')
          ],
          settings: { ...s.settings, workspacePerGroup: on }
        }))
      }

      it("opens each host in its group's workspace, named after it, and reuses it", () => {
        seedGroups()
        useStore.getState().openWorkspace('plain')
        open('a')
        open('c')
        open('b')
        const state = useStore.getState()
        expect(state.workspaces.map((w) => [w.title, w.tabs.length])).toEqual([
          ['plain', 0],
          ['TLS', 2],
          ['DNS', 1]
        ])
        expect(state.workspaces[1]).toMatchObject({ groupId: 'tls', color: '#0a0' })
        expect(titleOfActive()).toBe('TLS')
      })

      it("sends a host at the top of the tree to an ordinary workspace, not a group's", () => {
        seedGroups()
        useStore.getState().openWorkspace('plain')
        open('a')
        open('top')
        expect(titleOfActive()).toBe('plain')
      })

      it('sends picked hosts to their own groups, and a mixed grid to an ordinary one', () => {
        seedGroups()
        const item = (id: string) => ({
          title: id,
          target: { kind: 'session' as const, sessionId: id }
        })
        useStore.getState().openMany([item('a'), item('c')], 'tabs')
        expect(tabsOf('TLS')).toBe(1)
        expect(tabsOf('DNS')).toBe(1)
        useStore.getState().openMany([item('a'), item('b')], 'grid')
        expect(tabsOf('TLS')).toBe(2)
        useStore.getState().openMany([item('a'), item('c')], 'grid')
        expect(titleOfActive()).toBe('Workspace 1')
      })

      it('takes a group opened whole in a new workspace as that group’s', () => {
        seedGroups()
        useStore
          .getState()
          .openMany(
            [{ title: 'a', target: { kind: 'session', sessionId: 'a' } }],
            'workspace',
            'TLS',
            { groupId: 'tls' }
          )
        useStore.getState().openWorkspace('plain')
        open('b')
        expect(useStore.getState().workspaces.filter((w) => w.title === 'TLS')).toHaveLength(1)
        expect(tabsOf('TLS')).toBe(2)
      })

      it('sends a flat Git folder’s hosts to the folder’s workspace, not their Ansible group’s', () => {
        seedGroups()
        const all = { ...group('git:dc:g:all'), name: 'all', parentId: 'dc' } as SessionGroup
        const repoHost = { ...host('git:dc:h:v014'), groupId: all.id }
        useStore.setState((s) => ({
          groups: [...s.groups, { ...group('dc'), name: 'DC.nsd.ru' } as SessionGroup],
          sessions: [...s.sessions, { ...host('skdpu'), groupId: 'dc' }],
          gitFolderTrees: [
            {
              groupId: 'dc',
              groups: [all],
              sessions: [repoHost],
              memberships: { [repoHost.id]: [all.id] }
            }
          ]
        }))
        open('skdpu')
        open(repoHost.id)
        expect(titleOfActive()).toBe('DC.nsd.ru')
        expect(tabsOf('DC.nsd.ru')).toBe(2)

        // Shown as folders, the repository's groups are real places in the tree again.
        useStore.setState((s) => ({
          groups: s.groups.map((g) =>
            g.id === 'dc' ? { ...g, git: { showGroupFolders: true } } : g
          ) as SessionGroup[]
        }))
        open(repoHost.id)
        expect(titleOfActive()).toBe('all')
      })

      it("treats a group's workspace as an ordinary one with the setting off", () => {
        seedGroups()
        open('a')
        useStore.setState((s) => ({ settings: { ...s.settings, workspacePerGroup: false } }))
        open('c')
        expect(titleOfActive()).toBe('TLS')
        expect(tabsOf('TLS')).toBe(2)
      })
    })
  })
})

describe('multi-windows', () => {
  it('keeps a tab and opens it again as a new tab laid out the same', async () => {
    const saved: unknown[] = []
    window.td.multiWindows = {
      list: async () => saved as never,
      save: async (w) => {
        saved.splice(0, saved.length, w)
        return w
      },
      remove: async () => undefined,
      reorder: async () => undefined
    }
    useStore.setState({ workspaces: [], activeWorkspaceId: null, multiWindows: [] })
    useStore.getState().openTab('a', { kind: 'session', sessionId: 'a' })
    const tab = useStore.getState().workspaces[0].tabs[0]
    useStore.getState().splitPane(tab.id, tab.activePaneId, 'row')
    expect(await useStore.getState().saveTabAsMultiWindow(tab.id, 'Desk')).toBe(true)
    const kept = useStore.getState().multiWindows[0]
    expect(kept).toMatchObject({ name: 'Desk', root: { type: 'split', dir: 'row' } })

    useStore.getState().openMultiWindow(kept.id)
    const tabs = useStore.getState().workspaces[0].tabs
    expect(tabs).toHaveLength(2)
    expect(tabs[1].title).toBe('Desk')
    expect(collectLeaves(tabs[1].root).map((l) => l.target)).toEqual([
      { kind: 'session', sessionId: 'a' },
      { kind: 'session', sessionId: 'a' }
    ])
    expect(useStore.getState().workspaces[0].activeTabId).toBe(tabs[1].id)

    // Saved again under the same id: the old one is replaced, not added to.
    expect(await useStore.getState().saveTabAsMultiWindow(tabs[0].id, 'Desk 2', kept.id)).toBe(true)
    expect(useStore.getState().multiWindows).toHaveLength(1)
    expect(useStore.getState().multiWindows[0]).toMatchObject({ id: kept.id, name: 'Desk 2' })
  })
})

describe('the monitor under every SSH pane', () => {
  it('shows by the setting, closes for one pane by its button, and gives each back as it was', () => {
    useStore.setState((s) => ({
      workspaces: [],
      activeWorkspaceId: null,
      settings: { ...s.settings, monitorForAll: true }
    }))
    useStore.getState().openTab('a', { kind: 'session', sessionId: 'a' })
    const tab = () => useStore.getState().workspaces[0].tabs[0]
    const leaf = () => collectLeaves(tab().root)[0]
    expect(monitorShown(leaf(), true)).toBe(true)
    useStore.getState().toggleMonitor(tab().id, leaf().id)
    expect(monitorShown(leaf(), true)).toBe(false)
    // Off again: the pane is back to its own choice, which was closed.
    useStore.setState((s) => ({ settings: { ...s.settings, monitorForAll: false } }))
    expect(monitorShown(leaf(), false)).toBe(false)
    useStore.getState().toggleMonitor(tab().id, leaf().id)
    expect(monitorShown(leaf(), false)).toBe(true)
  })
})
