// @vitest-environment jsdom
import { it, expect, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import SftpTree from './SftpTree'

it('defers revealing a background terminal directory until the tree is visible', async () => {
  window.td.sftp.list = vi.fn(async () => [])
  const onOpen = vi.fn()
  const view = render(
    <SftpTree connectionId="c" path="/home/new" visible={false} onOpen={onOpen} />
  )
  expect(window.td.sftp.list).not.toHaveBeenCalled()
  await act(async () =>
    view.rerender(<SftpTree connectionId="c" path="/home/new" visible onOpen={onOpen} />)
  )
  expect(window.td.sftp.list).toHaveBeenCalledWith('c', '/home/new')
})
