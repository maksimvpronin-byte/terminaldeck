#!/usr/bin/env node
/**
 * What has to be true of a release, checked by something other than memory.
 *
 * Every rule here was written after the release it would have caught. Between
 * 0.9.0 and 0.10.2 this project shipped, in four days: a release drafted twice
 * with its artifacts split between the two halves; a Windows installer named
 * `TerminalDeck.Setup.0.9.1.exe` while `latest.yml` — the file the updater
 * reads — asked for `TerminalDeck-Setup-0.9.1.exe`, so every Windows update
 * would have failed on a 404, silently; and a macOS build with no signature at
 * all, which Apple Silicon refuses to run and reports as a damaged download.
 * Every one of those releases was green. CI cannot see any of it, because none
 * of it is a compile error or a failing test — it is a set of agreements
 * between files that nothing was comparing.
 *
 * Borrowed from KubeDeck, which keeps a `release-contract.json` and a verifier
 * beside it, and adapted rather than copied: its rules are about a Python
 * backend that must stay gone and an Apache licence that must stay whole, and
 * ours are about the three things above.
 *
 * Three modes, because the facts live in three places:
 *
 *   node scripts/verify-release.cjs                 the sources agree with each other
 *   node scripts/verify-release.cjs --release-dir packages --version 0.11.0
 *                                                   the built payload is whole
 *   node scripts/verify-release.cjs --app path/to/TerminalDeck.app
 *                                                   the bundle carries a signature
 *
 * The payload mode reads the update metadata with a regular expression rather
 * than a YAML parser, so it needs no `node_modules` and the release job can run
 * it straight after a checkout.
 */
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const root = path.resolve(__dirname, '..')
const args = process.argv.slice(2)

function option(name) {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : ''
}

function read(relativePath) {
  const target = path.join(root, relativePath)
  if (!fs.existsSync(target)) throw new Error(`Required file is missing: ${relativePath}`)
  return fs.readFileSync(target, 'utf8')
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function ok(message) {
  process.stdout.write(`  ✓ ${message}\n`)
}

/**
 * The version, in every file that states it.
 *
 * `npm version` writes all three, so they only disagree when somebody edits one
 * by hand — and the release workflow compares the tag against `package.json`
 * alone, so a lock file left behind would ship a build whose own manifest
 * disagrees with what was installed.
 */
function verifyVersion() {
  const pkg = JSON.parse(read('package.json'))
  const lock = JSON.parse(read('package-lock.json'))
  const version = pkg.version
  assert(
    /^\d+\.\d+\.\d+$/.test(version),
    `package.json version is not a release version: ${version}`
  )
  for (const [where, found] of [
    ['package-lock.json version', lock.version],
    ['package-lock.json packages[""].version', lock.packages?.['']?.version]
  ])
    assert(found === version, `${where} says ${found}, package.json says ${version}`)

  const tag = option('--tag')
  if (tag)
    assert(tag.replace(/^v/, '') === version, `Tag ${tag} does not match package.json ${version}`)
  ok(`version ${version}${tag ? ` matches ${tag}` : ''}`)
  return version
}

/**
 * The release notes exist before the release does.
 *
 * The notes are cut out of this file by the publishing step, and when the
 * section is missing that step fails after the twenty-minute build rather than
 * before it.
 */
function verifyChangelog(version) {
  const changelog = read('CHANGELOG.md')
  assert(
    new RegExp(`^## ${version.replace(/\./g, '\\.')}\\s*$`, 'm').test(changelog),
    `CHANGELOG.md has no "## ${version}" section; the release notes are cut from it`
  )
  ok(`CHANGELOG.md has a section for ${version}`)
}

/**
 * The packaging rules whose loss is invisible until somebody downloads the
 * result.
 */
function verifyPackaging() {
  const builder = read('electron-builder.yml')

  // Without this hook the macOS bundle goes out unsigned, and Apple Silicon
  // reports an unsigned application as damaged rather than as unverified.
  assert(
    /^afterPack:\s*resources\/adhoc-sign\.js\s*$/m.test(builder),
    'electron-builder.yml must keep the afterPack hook that signs the bundle ad-hoc'
  )

  // A name with a space in it is a name GitHub rewrites on upload, and the
  // update metadata keeps the hyphenated form: that mismatch is a 404 for every
  // Windows update.
  for (const target of ['nsis', 'portable']) {
    const section = new RegExp(`^${target}:\\n(?:[ \\t]+.*\\n|\\n)*`, 'm').exec(builder)
    assert(section, `electron-builder.yml has no ${target} section`)
    const name = /artifactName:\s*(.+)/.exec(section[0])
    assert(name, `${target} must state an artifactName; the default contains spaces`)
    assert(
      !/\s/.test(name[1].trim().replace(/\$\{[^}]+\}/g, 'x')),
      `${target} artifactName must not contain spaces: ${name[1].trim()}`
    )
    assert(name[1].includes('${version}'), `${target} artifactName must carry the version`)
  }
  ok('electron-builder keeps the signing hook and space-free artifact names')
}

/**
 * The workflow rules that keep one release in one place.
 *
 * electron-builder publishes by looking a release up by tag, and a draft has no
 * published tag to be found by — so every publisher that asked was told there
 * was none and made one of its own. Two drafts, artifacts split between them.
 * The fix was to stop publishing from the build jobs at all; these assertions
 * are what stops it coming back.
 */
function verifyWorkflow() {
  const workflow = read('.github/workflows/release.yml')
  assert(
    /npm run \$\{\{ matrix\.script \}\} -- --publish never/.test(workflow),
    'The build jobs must package with --publish never; publishing from the matrix drafts one release per publisher'
  )
  const creations = workflow.match(/gh release create/g) ?? []
  assert(
    creations.length === 1,
    `Exactly one step may create the release; found ${creations.length}`
  )
  assert(
    /^ {2}release:\n(?:.*\n)*?\s+needs: build\s*$/m.test(workflow),
    'The release job must wait for every build job'
  )
  ok('the release is assembled by one job, after every build')
}

/** Every artifact kind a complete release has, and how to recognise it. */
const KINDS = [
  { what: 'macOS disk image', match: /\.dmg$/ },
  { what: 'macOS zip (the updater reads this one)', match: /-mac\.zip$/ },
  { what: 'Windows installer', match: /-Setup-[\d.]+\.exe$/ },
  { what: 'Windows portable', match: /^(?!.*Setup)[^/]*\.exe$/ },
  { what: 'Linux AppImage', match: /\.AppImage$/ },
  { what: 'Linux package', match: /\.deb$/ },
  { what: 'Windows update metadata', match: /^latest\.yml$/ },
  { what: 'macOS update metadata', match: /^latest-mac\.yml$/ },
  { what: 'Linux update metadata', match: /^latest-linux\.yml$/ }
]

/**
 * The built release, before anybody can download it.
 *
 * Two questions, and the second is the one that was answered wrongly in the
 * wild: is every kind of artifact here exactly once, and does every file the
 * update metadata names actually exist under that name?
 */
function verifyPayload(directory, version) {
  const resolved = path.resolve(root, directory)
  assert(fs.existsSync(resolved), `Release directory does not exist: ${resolved}`)
  const files = fs
    .readdirSync(resolved)
    .filter((name) => !fs.statSync(path.join(resolved, name)).isDirectory())
  assert(files.length > 0, `Release directory is empty: ${resolved}`)

  for (const kind of KINDS) {
    const found = files.filter((name) => kind.match.test(name) && !name.endsWith('.blockmap'))
    assert(
      found.length === 1,
      `Expected exactly one ${kind.what}; found ${found.length}${found.length ? `: ${found.join(', ')}` : ''}`
    )
  }

  for (const name of files) {
    assert(
      !/\s/.test(name),
      `Artifact name contains a space, which GitHub rewrites on upload: ${name}`
    )
    if (!name.endsWith('.yml'))
      assert(name.includes(version), `Artifact does not carry version ${version}: ${name}`)
  }
  ok(`every artifact kind present once, named for ${version}`)

  // What the updater will ask for. `path:` names the package it downloads and
  // each `url:` names one of the files it may choose between; a name that is
  // not here is a 404 in front of every user who accepts the update.
  let referenced = 0
  for (const metadata of ['latest.yml', 'latest-mac.yml', 'latest-linux.yml']) {
    const text = fs.readFileSync(path.join(resolved, metadata), 'utf8')
    const names = [...text.matchAll(/^\s*(?:-\s*url|path):\s*(.+)\s*$/gm)].map((m) => m[1].trim())
    assert(names.length > 0, `${metadata} names no file at all`)
    for (const name of names) {
      assert(
        files.includes(name),
        `${metadata} points at ${name}, which is not in the release; the update would fail on a 404`
      )
      referenced++
    }
  }
  ok(`${referenced} update-metadata references all resolve`)
}

/**
 * The macOS bundle carries a signature — any signature.
 *
 * Ad-hoc is what this project can produce without a certificate, and it is the
 * difference between "unidentified developer", which a user can get past, and
 * "damaged", which tells them to throw the download away. With a certificate
 * configured the bar is the real one: a Developer ID, and not ad-hoc.
 */
function verifyApp(appPath) {
  const target = path.resolve(root, appPath)
  assert(fs.existsSync(target), `Application bundle does not exist: ${target}`)
  const result = spawnSync('codesign', ['-dv', '--verbose=4', target], { encoding: 'utf8' })
  const info = `${result.stdout ?? ''}${result.stderr ?? ''}`
  assert(result.status === 0, `codesign could not read ${appPath}: ${info || result.error}`)
  assert(
    /Signature=/.test(info),
    `${appPath} carries no signature; macOS reports such a build as damaged`
  )
  if (process.env.CSC_LINK) {
    assert(
      /Authority=Developer ID Application/.test(info),
      `${appPath} is not signed with a Developer ID identity`
    )
    assert(
      !/Signature=adhoc/.test(info),
      `${appPath} is only ad-hoc signed although a certificate is configured`
    )
  }
  ok(
    `${path.basename(target)} is signed (${/Signature=adhoc/.test(info) ? 'ad-hoc' : 'certificate'})`
  )
}

try {
  process.stdout.write('Release contract\n')
  const app = option('--app')
  if (app) {
    verifyApp(app)
  } else {
    const version = option('--version') || verifyVersion()
    if (!option('--version')) {
      verifyChangelog(version)
      verifyPackaging()
      verifyWorkflow()
    }
    const directory = option('--release-dir')
    if (directory) verifyPayload(directory, version)
  }
  process.stdout.write('Release contract satisfied.\n')
} catch (error) {
  process.stderr.write(`::error::${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
