import { describe, expect, it } from 'vitest'
import { canReplaceItself } from './adhocSigned'

/**
 * The rule that decides whether the banner offers an install or a download page.
 * Written down as a test because the wrong answer is invisible until somebody
 * on the affected platform presses the button: it downloads the whole package
 * and fails at the step after that.
 */
describe('whether a build can update itself', () => {
  it('says no to an ad-hoc signed macOS build', () => {
    expect(canReplaceItself('darwin', true)).toBe(false)
  })

  it('says yes once macOS has a real signature', () => {
    expect(canReplaceItself('darwin', false)).toBe(true)
  })

  /**
   * The marker is only ever written on macOS, but the rule is asked on every
   * platform and must not start refusing there if that ever changes: Windows
   * and Linux install an unsigned update without complaint.
   */
  it('says yes on Windows and Linux either way', () => {
    expect(canReplaceItself('win32', true)).toBe(true)
    expect(canReplaceItself('win32', false)).toBe(true)
    expect(canReplaceItself('linux', true)).toBe(true)
  })
})
