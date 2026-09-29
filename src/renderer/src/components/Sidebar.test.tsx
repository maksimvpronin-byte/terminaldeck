// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { createEvent, fireEvent, render, screen } from '@testing-library/react'
import Sidebar from './Sidebar'
import { useStore } from '../state/store'
import type { SessionGroup, SessionProfile } from '../../../shared/types'

function host(over: Partial<SessionProfile>): SessionProfile {
  return {
    id: 'h1',
    name: 'a-host',
    host: '10.0.0.1',
    groupId: null,
    tags: [],
    logToFile: false,
    portForwards: [],
    createdAt: 1,
    updatedAt: 1,
    ...over
  }
}

function rowFor(name: string): HTMLElement {
  const row = screen.getByText(name).closest('.tree-item')
  if (!row) throw new Error(`no row for ${name}`)
  return row as HTMLElement
}

/**
 * The slot in front of a name says what the row is; the colour says which
 * environment it belongs to. They were the same 8px dot, which answered the
 * second question and left the first one unasked.
 */
describe('what a host row shows', () => {
  it('marks a desktop and a terminal apart, and tints only what has a colour', () => {
    useStore.setState({
      sessions: [
        host({ id: 'h1', name: 'linux-box' }),
        host({ id: 'h2', name: 'win-box', protocol: 'rdp', color: '#e5534b' })
      ],
      groups: [],
      inventoryTrees: [],
      gitFolderTrees: [],
      gitFolderOverrides: [],
      inventoryOverrides: []
    })

    render(<Sidebar onOpenSnippets={() => {}} onOpenHelp={() => {}} />)

    expect(rowFor('linux-box').querySelector('.session-kind')?.getAttribute('title')).toBe(
      'Opens a terminal'
    )
    expect(rowFor('win-box').querySelector('.session-kind')?.getAttribute('title')).toBe(
      'Opens a desktop'
    )

    // The colour is the row's ground now, carried as a custom property, and a
    // host without one must not be tinted at all.
    expect(rowFor('win-box').classList.contains('tinted')).toBe(true)
    expect(rowFor('win-box').style.getPropertyValue('--host-colour')).toBe('#e5534b')
    expect(rowFor('linux-box').classList.contains('tinted')).toBe(false)
    expect(rowFor('linux-box').style.getPropertyValue('--host-colour')).toBe('')
  })

  /**
   * The width the row gives its name back.
   *
   * An Edit button stood at the right end of every row, hidden until hover and
   * laid out regardless — `visibility: hidden` reserves the space it hides — so
   * a name ended in an ellipsis with visible emptiness after it. Nothing may
   * take width on the right of a row again: the context menu is where editing
   * lives, and it always was.
   */
  it('keeps nothing on the right of a row that would shorten the name', () => {
    useStore.setState({
      sessions: [host({ id: 'h1', name: 'k8s2-mstr-001.test.local' })],
      groups: [],
      inventoryTrees: [],
      gitFolderTrees: [],
      gitFolderOverrides: [],
      inventoryOverrides: []
    })

    render(<Sidebar onOpenSnippets={() => {}} onOpenHelp={() => {}} />)

    const row = rowFor('k8s2-mstr-001.test.local')
    expect(row.querySelector('.actions')).toBeNull()
    expect(row.querySelector('button')).toBeNull()
  })

  /**
   * The dot this replaced sat after the name, inside the span that ellipsises,
   * so it disappeared in exactly the rows whose names were too long. Nothing
   * about the mark may depend on the name fitting, which is why it is asserted
   * on the element in front of it.
   */
  it('lights the mark while the machine is open, whichever kind of session it is', () => {
    const open = (paneId: string, sessionId: string, live: Record<string, string>) => ({
      type: 'leaf' as const,
      id: paneId,
      title: sessionId,
      target: { kind: 'session' as const, sessionId },
      sftpOpen: false,
      tunnelsOpen: false,
      monitorOpen: false,
      broadcastEnabled: true,
      ...live
    })

    useStore.setState({
      sessions: [
        host({ id: 'h1', name: 'linux-box' }),
        host({ id: 'h2', name: 'win-box', protocol: 'rdp' }),
        host({ id: 'h3', name: 'idle-box' })
      ],
      groups: [],
      inventoryTrees: [],
      gitFolderTrees: [],
      gitFolderOverrides: [],
      inventoryOverrides: [],
      workspaces: [
        {
          id: 'w1',
          title: 'w',
          tabs: [
            {
              id: 't1',
              title: 'a',
              activePaneId: 'p1',
              root: open('p1', 'h1', { connectionId: 'ssh-1' })
            },
            {
              id: 't2',
              title: 'b',
              activePaneId: 'p2',
              root: open('p2', 'h2', { desktopId: 'rdp-1' })
            }
          ],
          activeTabId: 't1'
        }
      ]
    })

    render(<Sidebar onOpenSnippets={() => {}} onOpenHelp={() => {}} />)

    expect(rowFor('linux-box').querySelector('.session-kind')?.className).toContain('live')
    // A desktop is as open as a shell, and only the terminal ever said so.
    expect(rowFor('win-box').querySelector('.session-kind')?.className).toContain('live')
    expect(rowFor('idle-box').querySelector('.session-kind')?.className).not.toContain('live')
  })
})

/**
 * The tree is indexed once per change rather than searched once per row, so
 * the search and the placement of mirrored hosts are checked against it here.
 */
describe('what the tree holds', () => {
  const group = (id: string, parentId: string | null, over: Partial<SessionGroup> = {}) =>
    ({ id, name: id, parentId, ...over }) as SessionGroup

  it('keeps a folder whose match is two levels down, and drops its empty sibling', () => {
    useStore.setState({
      groups: [group('outer', null), group('inner', 'outer'), group('empty', null)],
      sessions: [
        host({ id: 'h1', name: 'deep-db', groupId: 'inner' }),
        host({ id: 'h2', name: 'web', groupId: 'empty' })
      ],
      inventoryTrees: [],
      gitFolderTrees: [],
      gitFolderOverrides: [],
      inventoryOverrides: []
    })
    render(<Sidebar onOpenSnippets={() => {}} onOpenHelp={() => {}} />)

    fireEvent.change(screen.getByPlaceholderText('Filter hosts and groups…'), {
      target: { value: 'deep' }
    })

    expect(screen.getByText('outer')).toBeTruthy()
    expect(screen.getByText('inner')).toBeTruthy()
    expect(screen.getByText('deep-db')).toBeTruthy()
    expect(screen.queryByText('empty')).toBeNull()
    expect(screen.queryByText('web')).toBeNull()
  })

  it('shows a mirrored host under every group that names it', () => {
    const mirrored = host({ id: 'git:folder:h:db1', name: 'db1', groupId: 'git:folder:g:a' })
    useStore.setState({
      groups: [
        group('folder', null, {
          git: {
            repoUrl: 'git@example.com:x.git',
            paths: [],
            includedGroups: [],
            showGroupFolders: true
          }
        })
      ],
      sessions: [],
      inventoryTrees: [],
      gitFolderTrees: [
        {
          groupId: 'folder',
          groups: [group('git:folder:g:a', 'folder'), group('git:folder:g:b', 'folder')],
          sessions: [mirrored],
          memberships: { [mirrored.id]: ['git:folder:g:a', 'git:folder:g:b'] }
        }
      ],
      gitFolderOverrides: [],
      inventoryOverrides: []
    })
    render(<Sidebar onOpenSnippets={() => {}} onOpenHelp={() => {}} />)

    expect(screen.getAllByText('db1')).toHaveLength(2)
  })
})

describe('the host filter', () => {
  function withHosts(): void {
    useStore.setState({
      groups: [],
      sessions: [host({ id: 'h1', name: 'web' }), host({ id: 'h2', name: 'db' })],
      inventoryTrees: [],
      gitFolderTrees: [],
      gitFolderOverrides: [],
      inventoryOverrides: []
    })
    render(<Sidebar onOpenSnippets={() => {}} onOpenHelp={() => {}} />)
  }

  it('offers a cross only while something is typed, and the cross empties it', () => {
    withHosts()
    const field = screen.getByPlaceholderText('Filter hosts and groups…') as HTMLInputElement
    expect(screen.queryByRole('button', { name: 'Clear filter' })).toBeNull()

    fireEvent.change(field, { target: { value: 'web' } })
    expect(screen.queryByText('db')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Clear filter' }))
    expect(field.value).toBe('')
    expect(screen.getByText('db')).toBeTruthy()
    expect(document.activeElement).toBe(field)
    expect(screen.queryByRole('button', { name: 'Clear filter' })).toBeNull()
  })

  it('empties on Escape too', () => {
    withHosts()
    const field = screen.getByPlaceholderText('Filter hosts and groups…') as HTMLInputElement
    fireEvent.change(field, { target: { value: 'web' } })
    fireEvent.keyDown(field, { key: 'Escape' })
    expect(field.value).toBe('')
  })
})

describe('folders in the tree', () => {
  const prod: SessionGroup = { id: 'g1', name: 'prod', parentId: null, color: '#e5534b' }

  function showTree(): void {
    useStore.setState({
      sessions: [host({ id: 'h1', name: 'db-01', groupId: 'g1' })],
      groups: [prod],
      inventoryTrees: [],
      gitFolderTrees: [],
      gitFolderOverrides: [],
      inventoryOverrides: []
    })
    render(<Sidebar onOpenSnippets={() => {}} onOpenHelp={() => {}} />)
  }

  it('wears its colour, and lends it to a host that has none of its own', () => {
    showTree()
    expect(rowFor('prod').classList.contains('tinted')).toBe(true)
    expect(rowFor('db-01').style.getPropertyValue('--host-colour')).toBe('#e5534b')
  })

  it('marks the row a context menu was opened on, without selecting it', () => {
    showTree()
    fireEvent.contextMenu(rowFor('db-01'))
    expect(rowFor('db-01').classList.contains('menu-open')).toBe(true)
    expect(rowFor('db-01').classList.contains('selected')).toBe(false)
    expect(screen.getByText('Add to collection…')).toBeTruthy()
  })

  it('opens only from the arrow when Settings says so', () => {
    useStore.setState({
      settings: { ...useStore.getState().settings, expandOnArrowOnly: true }
    })
    showTree()
    fireEvent.click(rowFor('prod'))
    expect(screen.getByText('db-01')).toBeTruthy()
    const arrow = rowFor('prod').querySelector('.chevron')
    if (!arrow) throw new Error('no arrow')
    fireEvent.click(arrow)
    expect(screen.queryByText('db-01')).toBeNull()
    fireEvent.click(rowFor('prod').querySelector('.chevron') as Element)
    useStore.setState({
      settings: { ...useStore.getState().settings, expandOnArrowOnly: false }
    })
  })
})

/**
 * Searching by a folder's name, and opening or closing every folder at once.
 * The filter used to look at hosts alone, so typing the name of the folder
 * you could see in the tree made it vanish.
 */
describe('finding and folding folders', () => {
  const group = (id: string, parentId: string | null) =>
    ({ id, name: id, parentId }) as SessionGroup

  function setTree(): void {
    localStorage.clear()
    useStore.setState({
      groups: [group('prod', null), group('db', 'prod'), group('stage', null)],
      sessions: [
        host({ id: 'h1', name: 'web-1', groupId: 'prod' }),
        host({ id: 'h2', name: 'pg-1', groupId: 'db' }),
        host({ id: 'h3', name: 'web-2', groupId: 'stage' })
      ],
      collections: [],
      inventoryTrees: [],
      gitFolderTrees: [],
      gitFolderOverrides: [],
      inventoryOverrides: []
    })
  }

  it('shows a folder whose name matches with everything in it', () => {
    setTree()
    render(<Sidebar onOpenSnippets={() => {}} onOpenHelp={() => {}} />)

    fireEvent.change(screen.getByPlaceholderText('Filter hosts and groups…'), {
      target: { value: 'PROD' }
    })

    expect(screen.getByText('prod')).toBeTruthy()
    expect(screen.getByText('web-1')).toBeTruthy()
    expect(screen.getByText('db')).toBeTruthy()
    expect(screen.getByText('pg-1')).toBeTruthy()
    expect(screen.queryByText('stage')).toBeNull()
    expect(screen.queryByText('web-2')).toBeNull()
  })

  it('closes and opens every folder at once', () => {
    setTree()
    render(<Sidebar onOpenSnippets={() => {}} onOpenHelp={() => {}} />)
    expect(screen.getByText('pg-1')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Collapse all' }))
    expect(screen.queryByText('web-1')).toBeNull()
    expect(screen.queryByText('db')).toBeNull()
    expect(screen.getByText('stage')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }))
    expect(screen.getByText('web-1')).toBeTruthy()
    expect(screen.getByText('pg-1')).toBeTruthy()
    expect(screen.getByText('web-2')).toBeTruthy()
  })
})

/**
 * Putting hosts into a collection by dragging them there: a host, the ticked
 * hosts it is one of, or a whole folder — a folder a repository mirrors
 * included, whose hosts could not be dragged anywhere before.
 */
describe('dragging into a collection', () => {
  const group = (id: string, parentId: string | null, over: Partial<SessionGroup> = {}) =>
    ({ id, name: id, parentId, ...over }) as SessionGroup

  function transfer(): {
    types: string[]
    effectAllowed: string
    dropEffect: string
    setData: (k: string, v: string) => void
    getData: (k: string) => string
    setDragImage: () => void
  } {
    const data = new Map<string, string>()
    const t = {
      types: [] as string[],
      effectAllowed: '',
      dropEffect: '',
      setData: (k: string, v: string) => {
        data.set(k, v)
        if (!t.types.includes(k)) t.types.push(k)
      },
      getData: (k: string) => data.get(k) ?? '',
      setDragImage: () => {}
    }
    return t
  }

  function setTree(addToCollection: (id: string, hostIds: string[]) => Promise<void>): void {
    localStorage.clear()
    const a = host({ id: 'git:repo:h:a', name: 'mirrored-a', groupId: 'repo' })
    const b = host({ id: 'git:repo:h:b', name: 'mirrored-b', groupId: 'repo' })
    useStore.setState({
      groups: [
        group('repo', null, { git: { repoUrl: 'r', paths: [], includedGroups: [] } }),
        group('mine', null)
      ],
      sessions: [host({ id: 'h1', name: 'saved', groupId: 'mine' })],
      collections: [{ id: 'rel', name: 'Release', hostIds: [], createdAt: 0, updatedAt: 0 }],
      loadCollections: async () => {},
      addToCollection,
      inventoryTrees: [],
      gitFolderTrees: [{ groupId: 'repo', groups: [], sessions: [a, b], memberships: {} }],
      gitFolderOverrides: [],
      inventoryOverrides: [],
      selectedHostIds: []
    })
    render(<Sidebar onOpenSnippets={() => {}} onOpenHelp={() => {}} />)
  }

  it('puts every host of a folder from a repository into the collection it lands on', () => {
    const add = vi.fn(async () => {})
    setTree(add)
    const dt = transfer()
    fireEvent.dragStart(rowFor('repo'), { dataTransfer: dt })
    const target = rowFor('Release')
    fireEvent.dragOver(target, { dataTransfer: dt })
    expect(target.className).toContain('drop-target')
    fireEvent.drop(target, { dataTransfer: dt })

    expect(add).toHaveBeenCalledWith('rel', ['git:repo:h:a', 'git:repo:h:b'])
  })

  it('takes a single host, one from a repository included', () => {
    const add = vi.fn(async () => {})
    setTree(add)
    const dt = transfer()
    fireEvent.dragStart(rowFor('mirrored-b'), { dataTransfer: dt })
    fireEvent.drop(rowFor('Release'), { dataTransfer: dt })

    expect(add).toHaveBeenCalledWith('rel', ['git:repo:h:b'])
  })

  it('does not let a host from a repository move to another folder', () => {
    setTree(vi.fn(async () => {}))
    const dt = transfer()
    fireEvent.dragStart(rowFor('mirrored-a'), { dataTransfer: dt })
    const over = createEvent.dragOver(rowFor('mine'), { dataTransfer: dt })
    fireEvent(rowFor('mine'), over)

    expect(over.defaultPrevented).toBe(false)
    expect(screen.queryByText('Move to top level')).toBeNull()
  })
})
