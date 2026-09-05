// @vitest-environment jsdom
import { it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import AiPanel from './AiPanel'
import { useStore } from '../state/store'
import type { AiAnalysis } from '../../../shared/ai'

it('shows the exact proposal, requires a separate click, and exposes output/evidence', async () => {
  useStore.setState({ settings: { ...useStore.getState().settings, language: 'en' } })
  const view: AiAnalysis = {
    id: 'run',
    revision: 1,
    connectionId: 'conn',
    host: 'server.test',
    language: 'en',
    startedAt: Date.now(),
    status: 'awaiting',
    explanation: 'Baseline',
    modelRequests: 0,
    activeMs: 0,
    dataBytes: 0,
    provider: 'https://example.test/v1',
    model: 'fixture',
    steps: [
      {
        id: 'step',
        tool: 'space',
        command: 'df -hT',
        title: 'Disk capacity',
        purpose: 'Space',
        rights: 'No sudo',
        impact: 'Short read',
        timeoutMs: 15000,
        reason: 'Check free space',
        status: 'pending',
        proposedAt: Date.now()
      }
    ]
  }
  let update!: (next: AiAnalysis) => void
  const start = vi.fn(async () => {
    update(view)
    return view
  })
  const decide = vi.fn(async () => {})
  window.td.ai = {
    ...window.td.ai,
    get: async () => null,
    onUpdate: (cb) => {
      update = cb
      return () => {}
    },
    start,
    decide
  }
  const user = userEvent.setup()
  render(<AiPanel connectionId="conn" title="Server" visible onClose={() => {}} />)
  await user.click(screen.getByRole('button', { name: 'Analyze' }))
  expect(start).toHaveBeenCalledWith('conn', 'en')
  expect(decide).not.toHaveBeenCalled()
  expect(screen.getAllByText('df -hT').length).toBeGreaterThan(0)
  expect(screen.getAllByText('server.test').length).toBeGreaterThan(0)
  await user.click(screen.getByRole('button', { name: 'Run this command' }))
  expect(decide).toHaveBeenCalledWith('conn', 'run', 'step', 'approve')
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Run this command' })).toHaveProperty(
      'disabled',
      false
    )
  )
})
it('does not start a command while mounting or while the panel is hidden', async () => {
  const start = vi.fn()
  const decide = vi.fn()
  window.td.ai = { ...window.td.ai, get: async () => null, onUpdate: () => () => {}, start, decide }
  render(<AiPanel connectionId="other" title="Other" visible={false} onClose={() => {}} />)
  expect(start).not.toHaveBeenCalled()
  expect(decide).not.toHaveBeenCalled()
})
