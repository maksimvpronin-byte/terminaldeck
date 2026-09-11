// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import Sidebar from './Sidebar'
import { useStore } from '../state/store'
import type { SessionProfile } from '../../../shared/types'

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
