import { describe, expect, it } from 'vitest'
import { join } from 'path'
import { ADHOC_MARKER } from '../shared/adhocSigned'

/**
 * The build hook that signs a macOS bundle ad-hoc, tested for the two things it
 * must not do: run anywhere but macOS, and touch a build that has a real
 * certificate. Getting the second wrong would replace a Developer ID signature
 * with a worthless one on the day the certificate is finally configured, and
 * the build would report success either way.
 *
 * It lives outside `src/` because electron-builder loads it by path, so it is
 * reached the same way here.
 */

const { signingPlan } = await import('../../resources/adhoc-sign.js')

function context(platform: string) {
  return {
    electronPlatformName: platform,
    appOutDir: '/tmp/out',
    packager: { appInfo: { productFilename: 'TerminalDeck' } }
  }
}

describe('the ad-hoc signing hook', () => {
  it('signs the bundle when nothing else will', () => {
    expect(signingPlan(context('darwin'), {})).toEqual({
      command: 'codesign',
      args: ['--force', '--deep', '--sign', '-', join('/tmp/out', 'TerminalDeck.app')],
      app: join('/tmp/out', 'TerminalDeck.app'),
      marker: join('/tmp/out', 'TerminalDeck.app', 'Contents', 'Resources', ADHOC_MARKER)
    })
  })

  /**
   * The hook writes the marker and the updater looks for it, and the two name it
   * separately — the hook is CommonJS loaded by path and cannot import the
   * constant. A rename on one side alone is what this catches.
   */
  it('leaves the marker where the updater looks for it', () => {
    const plan = signingPlan(context('darwin'), {})
    expect(plan?.marker.endsWith(join('Contents', 'Resources', ADHOC_MARKER))).toBe(true)
  })

  it('leaves a properly signed build alone', () => {
    expect(signingPlan(context('darwin'), { CSC_LINK: 'a certificate' })).toBeNull()
  })

  it('does nothing on the other platforms', () => {
    expect(signingPlan(context('win32'), {})).toBeNull()
    expect(signingPlan(context('linux'), {})).toBeNull()
  })
})
