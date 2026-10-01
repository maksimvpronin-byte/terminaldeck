// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import PasswordInput from './PasswordInput'

describe('a password field with an eye', () => {
  it('shows what was typed while asked, and hides it again', () => {
    render(<PasswordInput value="s3cret" onChange={() => {}} />)
    const field = screen.getByDisplayValue('s3cret') as HTMLInputElement
    expect(field.type).toBe('password')
    fireEvent.click(screen.getByRole('button', { name: 'Show password' }))
    expect(field.type).toBe('text')
    fireEvent.click(screen.getByRole('button', { name: 'Hide password' }))
    expect(field.type).toBe('password')
  })

  it('stays out of the Tab order and leaves the caret in the field', () => {
    render(<PasswordInput value="" onChange={() => {}} />)
    const eye = screen.getByRole('button', { name: 'Show password' })
    expect(eye.tabIndex).toBe(-1)
    const down = fireEvent.mouseDown(eye)
    // Default prevented: the press does not take the focus from the field.
    expect(down).toBe(false)
  })
})
