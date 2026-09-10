// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import UpdateBanner from './UpdateBanner'

/**
 * A build that cannot install an update over itself must not offer to. Getting
 * this wrong is expensive in a way nothing else here is: the button downloads
 * the whole package before the step that cannot work, so the mistake is only
 * visible after a hundred megabytes and a wait.
 */
it('sends an ad-hoc build to the downloads instead of installing', async () => {
  const openPage = vi.fn().mockResolvedValue(undefined)
  const download = vi.fn()
  window.td.updates.getState = () => Promise.resolve({ status: 'manual', version: '0.13.2' })
  window.td.updates.onState = () => () => undefined
  window.td.updates.openPage = openPage
  window.td.updates.download = download

  render(<UpdateBanner />)

  await screen.findByText('Version 0.13.2 is out. This build cannot install it over itself.')
  expect(screen.queryByRole('button', { name: 'Download' })).not.toBeInTheDocument()

  await userEvent.click(screen.getByRole('button', { name: 'Open the downloads' }))
  expect(openPage).toHaveBeenCalledTimes(1)
  expect(download).not.toHaveBeenCalled()
})

it('still offers the install where it works', async () => {
  window.td.updates.getState = () => Promise.resolve({ status: 'available', version: '0.13.2' })
  window.td.updates.onState = () => () => undefined

  render(<UpdateBanner />)

  await screen.findByRole('button', { name: 'Download' })
  expect(screen.queryByRole('button', { name: 'Open the downloads' })).not.toBeInTheDocument()
})
