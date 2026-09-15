// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import AuthPromptDialog from './AuthPromptDialog'
import type { AuthPromptRequest } from '../../../shared/types'

/**
 * Several hosts asking at once — opening a group with no saved passwords. Each
 * question used to replace the one before it, and the replaced ones were never
 * answered.
 */

function question(requestId: string, host: string): AuthPromptRequest {
  return {
    requestId,
    host,
    title: 'Password required',
    fields: [{ prompt: 'Password', echo: false }]
  }
}

function wire(): {
  ask: (req: AuthPromptRequest) => void
  withdraw: (requestId: string) => void
  reply: ReturnType<typeof vi.fn>
} {
  let ask: (req: AuthPromptRequest) => void = () => undefined
  let withdraw: (requestId: string) => void = () => undefined
  const reply = vi.fn()
  window.td.auth = {
    onPrompt: (cb: (req: AuthPromptRequest) => void) => {
      ask = cb
      return () => undefined
    },
    onCancel: (cb: (requestId: string) => void) => {
      withdraw = cb
      return () => undefined
    },
    reply
  } as unknown as typeof window.td.auth
  return { ask: (req) => act(() => ask(req)), withdraw: (id) => act(() => withdraw(id)), reply }
}

describe('credential prompts', () => {
  it('answers every question, in the order they were asked', async () => {
    const { ask, reply } = wire()
    render(<AuthPromptDialog />)
    ask(question('one', 'me@first'))
    ask(question('two', 'me@second'))

    expect(screen.getByText('me@first')).toBeInTheDocument()
    await userEvent.type(screen.getByLabelText('Password'), 'first secret{Enter}')
    expect(reply).toHaveBeenLastCalledWith('one', ['first secret'])

    expect(screen.getByText('me@second')).toBeInTheDocument()
    // Its field starts empty, not holding what was typed for the first.
    expect(screen.getByLabelText('Password')).toHaveValue('')
    await userEvent.type(screen.getByLabelText('Password'), 'second secret{Enter}')
    expect(reply).toHaveBeenLastCalledWith('two', ['second secret'])
    expect(screen.queryByText('Password required')).not.toBeInTheDocument()
  })

  it('takes down a question the main process withdrew', () => {
    const { ask, withdraw } = wire()
    render(<AuthPromptDialog />)
    ask(question('one', 'me@first'))
    ask(question('two', 'me@second'))

    withdraw('one')

    expect(screen.queryByText('me@first')).not.toBeInTheDocument()
    expect(screen.getByText('me@second')).toBeInTheDocument()
  })
})
