// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { SftpEntry } from '../../../shared/types'
import { SFTP_DRAG, endDrag } from '../state/sftpDrag'
import SftpPanel from './SftpPanel'

/**
 * Picking rows out of the listing, and handing them to a drag.
 *
 * The two are one behaviour: what is dragged is what is selected, and a row
 * dragged from outside the selection takes itself alone. Both were only ever
 * exercised by hand, between two live SSH sessions, which is a poor place to
 * find out that a row no longer highlights.
 */

function entry(name: string, isDirectory = false): SftpEntry {
  return {
    name,
    path: `/home/u/${name}`,
    isDirectory,
    isSymlink: false,
    size: 10,
    mtime: 1,
    permissions: isDirectory ? '755' : '644',
    owner: 'u',
    group: 'g'
  }
}

const listing = [entry('docker', true), entry('.bashrc'), entry('.profile')]

beforeEach(() => {
  endDrag()
  window.td.sftp.list = () => Promise.resolve(listing)
  window.td.sftp.realpath = () => Promise.resolve('/home/u')
  window.td.sftp.onProgress = () => () => undefined
  window.td.sftp.onEdited = () => () => undefined
  window.td.ssh.onCwd = () => () => undefined
  window.td.ssh.getFollowCwd = () => Promise.resolve(false)
})

/** The row element for a file, which is the thing that carries the drag. */
async function row(name: string): Promise<HTMLElement> {
  const cell = await screen.findByTitle(name)
  return cell.closest('.sftp-row') as HTMLElement
}

describe('choosing rows in the file panel', () => {
  it('selects the row that was clicked', async () => {
    render(<SftpPanel connectionId="c1" />)

    const bashrc = await row('.bashrc')
    await userEvent.click(bashrc)

    expect(bashrc.className).toContain('selected')
  })

  it('adds to the selection with the modifier, and drops the previous one without', async () => {
    render(<SftpPanel connectionId="c1" />)
    const bashrc = await row('.bashrc')
    const profile = await row('.profile')

    await userEvent.click(bashrc)
    // fireEvent rather than userEvent: the modifier has to be on the click
    // itself, which is what the panel reads, and userEvent's own modifier is a
    // separate key press this component never sees.
    fireEvent.click(profile, { ctrlKey: true })
    expect(bashrc.className).toContain('selected')
    expect(profile.className).toContain('selected')

    await userEvent.click(profile)
    expect(bashrc.className).not.toContain('selected')
  })
})

/** jsdom has no DataTransfer, and the panel only ever writes to one. */
function dataTransfer(): { types: string[]; data: Record<string, string> } & {
  setData: (type: string, value: string) => void
  effectAllowed: string
} {
  const data: Record<string, string> = {}
  return {
    types: [],
    data,
    effectAllowed: '',
    setData: (type, value) => {
      data[type] = value
    }
  }
}

describe('dragging rows out of the file panel', () => {
  it('carries every selected row', async () => {
    render(<SftpPanel connectionId="c1" />)
    const bashrc = await row('.bashrc')
    const profile = await row('.profile')
    await userEvent.click(bashrc)
    fireEvent.click(profile, { ctrlKey: true })

    const transfer = dataTransfer()
    fireEvent.dragStart(bashrc, { dataTransfer: transfer })

    expect(JSON.parse(transfer.data[SFTP_DRAG])).toEqual({
      connectionId: 'c1',
      paths: ['/home/u/.bashrc', '/home/u/.profile']
    })
  })

  /** Matching the context menu: acting on a row outside the selection is about
      that row, not about what happens to be highlighted elsewhere. */
  it('carries a row dragged from outside the selection on its own', async () => {
    render(<SftpPanel connectionId="c1" />)
    await userEvent.click(await row('.bashrc'))

    const transfer = dataTransfer()
    fireEvent.dragStart(await row('.profile'), { dataTransfer: transfer })

    expect(JSON.parse(transfer.data[SFTP_DRAG]).paths).toEqual(['/home/u/.profile'])
  })
})
