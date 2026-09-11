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
})
