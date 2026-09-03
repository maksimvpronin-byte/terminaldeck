import { describe, expect, it } from 'vitest'
import { join } from 'path'

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
      app: join('/tmp/out', 'TerminalDeck.app')
    })
  })

  it('leaves a properly signed build alone', () => {
    expect(signingPlan(context('darwin'), { CSC_LINK: 'a certificate' })).toBeNull()
  })

  it('does nothing on the other platforms', () => {
    expect(signingPlan(context('win32'), {})).toBeNull()
    expect(signingPlan(context('linux'), {})).toBeNull()
  })
})
