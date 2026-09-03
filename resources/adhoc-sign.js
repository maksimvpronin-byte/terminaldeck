const { execFileSync } = require('child_process')
const { join } = require('path')

/**
 * Signs the macOS bundle with nothing in particular, when there is no
 * certificate to sign it with.
 *
 * An unsigned build was not merely unverified — on Apple Silicon it would not
 * start at all. Every arm64 executable has to carry a signature for the kernel
 * to run it, ad-hoc counts, and electron-builder skips signing entirely when no
 * identity is configured. macOS reports the result as "«TerminalDeck» is damaged
 * and can't be opened", which reads as a bad download and is nothing of the
 * kind: the disk image is fine and the application inside it is unsigned.
 *
 * An ad-hoc signature fixes the launch and nothing else. Gatekeeper still knows
 * nobody vouched for the application, and still asks — but it asks the ordinary
 * question, with "Open Anyway" in Privacy & Security behind it, instead of
 * telling people to move a working download to the Trash. The real answer is a
 * Developer ID certificate and notarization; this is what the build can do
 * without one.
 *
 * Skipped when a certificate *is* configured: electron-builder then signs the
 * bundle properly, and re-signing it here would throw that away.
 */

/**
 * What to run, or nothing at all — kept apart from the running of it so the two
 * refusals can be tested without a Mac and without a build.
 *
 * `--deep` is deprecated by Apple and is right here anyway: the reason to sign
 * each nested binary on its own is to give each its own entitlements, and an
 * ad-hoc signature has none to give. Everything inside — the Electron helpers,
 * the desktop client and the libraries beside it — needs a signature of some
 * kind, and this is the one command that reaches all of them.
 */
exports.signingPlan = function signingPlan(context, env) {
  if (context.electronPlatformName !== 'darwin') return null
  // A real certificate is configured, so electron-builder signs the bundle
  // properly and re-signing it here would throw that away.
  if (env.CSC_LINK) return null

  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  return { command: 'codesign', args: ['--force', '--deep', '--sign', '-', app], app }
}

exports.default = async function adhocSign(context) {
  const plan = exports.signingPlan(context, process.env)
  if (!plan) return
  execFileSync(plan.command, plan.args, { stdio: 'inherit' })
  console.log(`  • signed ad-hoc  reason=no certificate configured, file=${plan.app}`)
}
