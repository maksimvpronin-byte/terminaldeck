// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import type { SftpEntry } from '../../../shared/types'
import SftpPanel from './SftpPanel'

vi.mock('./SftpTree', () => ({ default: () => null }))
function entry(i: number): SftpEntry {
  const name = `file-${String(i).padStart(5, '0')}`
  return {
    name,
    path: `/home/${name}`,
    size: i,
    mtime: 0,
    isDirectory: false,
    isSymlink: false,
    permissions: '644',
    owner: 'u',
    group: 'g'
  }
}
const listing = Array.from({ length: 10000 }, (_, i) => entry(i))
let progress: (p: { path: string; transferred: number; total: number }) => void
let cwd: (p: string) => void
beforeEach(() => {
  window.td.sftp.realpath = vi.fn(async () => '/home')
  window.td.sftp.list = vi.fn(async () => [...listing])
  window.td.sftp.onProgress = (_id, cb) => {
    progress = cb
    return () => undefined
  }
  window.td.sftp.onEdited = () => () => undefined
  window.td.ssh.onCwd = (_id, cb) => {
    cwd = cb
    return () => undefined
  }
  window.td.ssh.getFollowCwd = async () => false
})
afterEach(() => vi.useRealTimers())
async function mount(visible = true) {
  const result = render(<SftpPanel connectionId="c" visible={visible} />)
  await act(async () => {})
  return result
}

describe('large and background file panels', () => {
  it('bounds DOM rows and retains selection across a virtual scroll', async () => {
    const { container } = await mount()
    expect(container.querySelectorAll('.sftp-row').length).toBeLessThan(60)
    fireEvent.click(screen.getByTitle('file-00000'))
    const list = container.querySelector('.sftp-list')!
    fireEvent.scroll(list, { target: { scrollTop: 150000 } })
    expect(screen.queryByTitle('file-00000')).toBeNull()
    const distant = screen.getByTitle('file-05000')
    fireEvent.click(distant, { shiftKey: true })
    fireEvent.scroll(list, { target: { scrollTop: 0 } })
    expect(screen.getByTitle('file-00000').closest('.sftp-row')).toHaveClass('selected')
    expect(screen.getByTitle('file-00010').closest('.sftp-row')).toHaveClass('selected')
    expect(container.querySelectorAll('.sftp-row').length).toBeLessThan(60)
  })
  it('does not redraw file rows for successive progress events', async () => {
    const { container } = await mount()
    act(() => progress({ path: '/big', transferred: 1, total: 100 }))
    const mutations = vi.fn()
    const observer = new MutationObserver(mutations)
    observer.observe(container.querySelector('.sftp-list')!, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true
    })
    for (let i = 2; i < 10; i++)
      await act(async () => progress({ path: '/big', transferred: i, total: 100 }))
    expect(mutations).not.toHaveBeenCalled()
    observer.disconnect()
    act(() => progress({ path: '/big', transferred: 100, total: 100 }))
    expect(container.querySelector('.sftp-progress')).toBeNull()
  })
  it('pauses background polling and refreshes on returning', async () => {
    const result = await mount()
    vi.useFakeTimers()
    result.rerender(<SftpPanel connectionId="c" visible={false} />)
    const calls = vi.mocked(window.td.sftp.list).mock.calls.length
    await act(async () => vi.advanceTimersByTime(20000))
    expect(window.td.sftp.list).toHaveBeenCalledTimes(calls)
    await act(async () => result.rerender(<SftpPanel connectionId="c" visible />))
    expect(window.td.sftp.list).toHaveBeenCalledTimes(calls + 1)
  })
  it('does not pile up polls while a listing is still in flight', async () => {
    const result = await mount(false)
    vi.useFakeTimers()
    let finish!: (entries: SftpEntry[]) => void
    window.td.sftp.list = vi.fn(
      () =>
        new Promise<SftpEntry[]>((resolve) => {
          finish = resolve
        })
    )
    await act(async () => result.rerender(<SftpPanel connectionId="c" visible />))
    await act(async () => vi.advanceTimersByTime(20000))
    expect(window.td.sftp.list).toHaveBeenCalledTimes(1)
    await act(async () => finish([]))
  })
  it('ignores an old directory response after a newer navigation completes', async () => {
    await mount()
    let old!: (entries: SftpEntry[]) => void
    window.td.sftp.list = vi.fn((_id: string, path: string) =>
      path === '/old'
        ? new Promise<SftpEntry[]>((resolve) => {
            old = resolve
          })
        : Promise.resolve([{ ...entry(1), path: '/new/newest', name: 'newest' }])
    )
    await act(async () => cwd('/old'))
    await act(async () => cwd('/new'))
    expect(screen.getByTitle('newest')).toBeInTheDocument()
    await act(async () => old([{ ...entry(2), path: '/old/stale', name: 'stale' }]))
    expect(screen.queryByTitle('stale')).toBeNull()
    expect(screen.getByTitle('newest')).toBeInTheDocument()
  })
  it('reveals a typed file path even when its row starts far outside the viewport', async () => {
    const { container } = await mount()
    window.td.sftp.realpath = async () => '/home/file-09000'
    window.td.sftp.stat = async () => entry(9000)
    const input = container.querySelector('.sftp-path-input')!
    fireEvent.change(input, { target: { value: '/home/file-09000' } })
    await act(async () => fireEvent.keyDown(input, { key: 'Enter' }))
    expect(screen.getByTitle('file-09000').closest('.sftp-row')).toHaveClass('selected')
  })
})
