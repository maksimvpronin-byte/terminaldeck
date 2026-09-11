// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import Pane from './Pane'
import { useStore } from '../state/store'
import type { GitFolderTree, SessionProfile } from '../../../shared/types'
import type { PaneNode } from '../state/store'

const windowsHost: SessionProfile = {
  id: 'git:dc1',
  name: 'rbt-srv-v008p.nsd.ru',
  protocol: 'rdp',
  host: '10.75.20.20',
  groupId: 'folder-win-20',
  tags: [],
  logToFile: false,
  portForwards: [],
  createdAt: 1,
  updatedAt: 1
}

const tree: GitFolderTree = {
  groupId: 'folder-win-20',
  groups: [],
  sessions: [windowsHost],
  memberships: {}
}

const leaf = {
  type: 'leaf',
  id: 'pane1',
  target: { kind: 'session', sessionId: windowsHost.id }
} as Extract<PaneNode, { type: 'leaf' }>

/**
 * A host that came from a repository is not in `sessions` — that list is what
 * somebody typed into the Sessions tab. Every reader that forgets it answers
 * "no such host", and for the protocol that answer is SSH, so a Windows machine
 * from an inventory opened a terminal and dialled 3389 as SSH.
 */
describe('a pane on a host mirrored from a repository', () => {
  it('opens the desktop its inventory asked for, not a terminal', () => {
    useStore.setState({
      sessions: [],
      gitFolderTrees: [tree],
      gitFolderOverrides: [],
      inventoryTrees: [],
      inventoryOverrides: []
    })
    window.td.rdp.settings = vi.fn().mockResolvedValue(null)
    window.td.rdp.login = vi.fn().mockResolvedValue({ username: 'solonkin_adm', hasPassword: true })

    render(<Pane tabId="tab1" node={leaf} />)

    // The desktop pane names the address it is reaching, and there is no
    // terminal in a pane that opened one.
    expect(screen.getByText(/10\.75\.20\.20:3389/)).toBeInTheDocument()
  })

  /**
   * End to end, because every link in it was added at once and a break anywhere
   * shows up the same way: the tree says the machine is closed while a desktop
   * is on screen.
   */
  it('tells the store which desktop it is holding, so the tree can light up', async () => {
    useStore.setState({
      sessions: [],
      gitFolderTrees: [tree],
      gitFolderOverrides: [],
      inventoryTrees: [],
      inventoryOverrides: [],
      workspaces: [
        {
          id: 'w1',
          title: 'w',
          activeTabId: 'tab1',
          tabs: [{ id: 'tab1', title: 't', activePaneId: leaf.id, root: leaf }]
        }
      ]
    })
    // What a canvas and a live screen need from a browser jsdom does not have.
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(): void {}
        disconnect(): void {}
      }
    )
    window.matchMedia = vi.fn(
      () => ({ addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList
    )
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      {} as unknown as CanvasRenderingContext2D
    )
    window.td.rdp.settings = vi.fn().mockResolvedValue(null)
    window.td.rdp.login = vi.fn().mockResolvedValue({ username: 'solonkin_adm', hasPassword: true })
    window.td.rdp.desktopStart = vi.fn().mockResolvedValue('desktop-1')
    window.td.rdp.desktopStop = vi.fn().mockResolvedValue(undefined)
    window.td.rdp.onDesktopEvent = () => () => undefined
    window.td.rdp.onDesktopFrame = () => () => undefined
    window.td.rdp.onDesktopCursor = () => () => undefined
    window.td.ui.onForwardKey = () => () => undefined

    render(<Pane tabId="tab1" node={leaf} />)

    await userEvent.click(await screen.findByRole('button', { name: 'New session' }))
    await waitFor(() => expect(window.td.rdp.desktopStart).toHaveBeenCalled())

    await waitFor(() => {
      const root = useStore.getState().workspaces[0].tabs[0].root
      expect(root.type === 'leaf' && root.desktopId).toBe('desktop-1')
    })
  })

  /** The local override wins over the repository, here as everywhere else. */
  it('honours a protocol stated in the host’s local settings', () => {
    useStore.setState({
      sessions: [],
      gitFolderTrees: [{ ...tree, sessions: [{ ...windowsHost, protocol: undefined }] }],
      gitFolderOverrides: [{ nodeId: windowsHost.id, protocol: 'rdp' }],
      inventoryTrees: [],
      inventoryOverrides: []
    })
    window.td.rdp.settings = vi.fn().mockResolvedValue(null)
    window.td.rdp.login = vi.fn().mockResolvedValue({ username: 'solonkin_adm', hasPassword: true })

    render(<Pane tabId="tab1" node={leaf} />)

    expect(screen.getByText(/10\.75\.20\.20:3389/)).toBeInTheDocument()
  })
})
