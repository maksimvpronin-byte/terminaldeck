// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { SftpEntry } from '../../../shared/types'
import SftpPanel from './SftpPanel'

/**
 * Sorting, filtering and searching the listing, and what a double-click on a
 * file does. All four were missing or wrong on SCP/Shell hosts and SFTP alike:
 * the headings sorted nothing, there was no way to look for a file, and a
 * double-click offered to save the file rather than open it.
 */

function entry(name: string, extra: Partial<SftpEntry> = {}): SftpEntry {
  return {
    name,
    path: `/srv/${name}`,
    isDirectory: false,
    isSymlink: false,
    size: 10,
    mtime: 1000,
    permissions: '644',
    owner: 'u',
    group: 'g',
    ...extra
  }
}

const listing = [
  entry('old.log', { mtime: 1000 }),
  entry('new.log', { mtime: 3000 }),
  entry('app.conf', { mtime: 2000 }),
  entry('logs', { isDirectory: true, mtime: 500 })
]

beforeEach(() => {
  localStorage.clear()
  window.td.sftp.list = () => Promise.resolve(listing)
  window.td.sftp.realpath = () => Promise.resolve('/srv')
  window.td.sftp.onProgress = () => () => undefined
  window.td.sftp.onEdited = () => () => undefined
  window.td.ssh.onCwd = () => () => undefined
  window.td.ssh.getFollowCwd = () => Promise.resolve(false)
  window.td.ssh.getFileAccess = () => Promise.resolve(undefined)
})

/** File names in the order the listing shows them. */
function shown(): string[] {
  return Array.from(document.querySelectorAll('.sftp-row .name'))
    .map((cell) => cell.getAttribute('title') ?? '')
    .filter((name) => name !== '')
}

describe('sorting the file panel', () => {
  it('sorts by date, newest first, when the heading is clicked, and back again', async () => {
    render(<SftpPanel connectionId="c1" />)
    await screen.findByTitle('old.log')
    expect(shown()).toEqual(['logs', 'app.conf', 'new.log', 'old.log'])

    await userEvent.click(screen.getByTitle('Sort by Changed'))
    expect(shown()).toEqual(['logs', 'new.log', 'app.conf', 'old.log'])

    await userEvent.click(screen.getByTitle('Sort by Changed'))
    expect(shown()).toEqual(['logs', 'old.log', 'app.conf', 'new.log'])
  })

  it('remembers the order for the next panel', async () => {
    const first = render(<SftpPanel connectionId="c1" />)
    await screen.findByTitle('old.log')
    await userEvent.click(screen.getByTitle('Sort by Changed'))
    first.unmount()

    render(<SftpPanel connectionId="c2" />)
    await screen.findByTitle('old.log')
    expect(shown()).toEqual(['logs', 'new.log', 'app.conf', 'old.log'])
  })
})

describe('looking for files', () => {
  it('narrows the folder as the name is typed', async () => {
    render(<SftpPanel connectionId="c1" />)
    await screen.findByTitle('old.log')
    await userEvent.type(screen.getByPlaceholderText(/Filter by name/), '*.log')
    expect(shown()).toEqual(['new.log', 'old.log'])
  })

  it('searches the subfolders on Enter and shows where each result lives', async () => {
    const find = vi.fn().mockResolvedValue({
      root: '/srv',
      entries: [entry('deep.log', { path: '/srv/logs/2026/deep.log' })],
      truncated: false
    })
    window.td.sftp.find = find
    render(<SftpPanel connectionId="c1" />)
    await screen.findByTitle('old.log')

    await userEvent.type(screen.getByPlaceholderText(/Filter by name/), 'deep{Enter}')

    expect(await screen.findByTitle('/srv/logs/2026/deep.log')).toHaveTextContent(
      'logs/2026/deep.log'
    )
    expect(find).toHaveBeenCalledWith('c1', '/srv', 'deep')
    expect(screen.getByText('Found 1 under /srv')).toBeTruthy()
  })

  it('goes back to the folder when the filter is cleared', async () => {
    window.td.sftp.find = vi
      .fn()
      .mockResolvedValue({ root: '/srv', entries: [entry('x.log')], truncated: false })
    render(<SftpPanel connectionId="c1" />)
    await screen.findByTitle('old.log')
    await userEvent.type(screen.getByPlaceholderText(/Filter by name/), 'x{Enter}')
    await screen.findByText('Found 1 under /srv')

    await userEvent.click(screen.getByRole('button', { name: 'Clear filter' }))
    await waitFor(() => expect(shown()).toEqual(['logs', 'app.conf', 'new.log', 'old.log']))
  })
})

describe('double-clicking a file', () => {
  it('opens it in the editor instead of offering to save it', async () => {
    const edit = vi.fn().mockResolvedValue('/tmp/x')
    const pickSavePath = vi.fn()
    window.td.sftp.edit = edit
    window.td.dialogs.pickSavePath = pickSavePath
    render(<SftpPanel connectionId="c1" />)

    fireEvent.doubleClick(await screen.findByTitle('app.conf'))

    await waitFor(() => expect(edit).toHaveBeenCalledWith('c1', '/srv/app.conf', ''))
    expect(pickSavePath).not.toHaveBeenCalled()
  })
})
