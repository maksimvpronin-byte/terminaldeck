#!/usr/bin/env node
// Checks the components behind report.html, in both the lock file and the
// installed tree. A successful npm audit alone cannot detect bundled 7-Zip.
const fs = require('node:fs')
const path = require('node:path')
const { createRequire } = require('node:module')

const root = path.resolve(__dirname, '..')
const forbidden = new Set(['electron-builder-squirrel-windows', 'electron-winstaller'])
const archiveBinary = /^(?:7z|7za|7zz)(?:\.exe|\.dll)?$/i

function checkComponent(name, version, location) {
  if (forbidden.has(name)) {
    throw new Error(`${location}: unused ${name} brings obsolete 7-Zip binaries`)
  }
  if (name !== 'minimatch') return
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-.*)?$/.exec(version ?? '')
  if (!match) throw new Error(`${location}: cannot verify minimatch version ${version}`)
  const [major, minor, patch] = match.slice(1).map(Number)
  if (major >= 7 && (major < 11 || (major === 11 && minor === 0 && patch === 0))) {
    throw new Error(`${location}: minimatch ${version} is affected by GHSA-g3hv-75wg-m249`)
  }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function checkNativeVersions(versions, location) {
  const required = readJson(path.join(root, 'resources/freerdp/native-versions.json'))
  for (const [name, minimum] of Object.entries(required)) {
    const actual = versions[name]
    if (typeof actual !== 'string' || !/^\d+(?:\.\d+)+$/.test(actual)) {
      throw new Error(`${location}: missing or invalid ${name} version`)
    }
    const a = actual.split('.').map(Number)
    const b = minimum.split('.').map(Number)
    let comparison = 0
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      comparison = (a[i] ?? 0) - (b[i] ?? 0)
      if (comparison) break
    }
    if (comparison < 0) throw new Error(`${location}: ${name} ${actual} is older than ${minimum}`)
  }
}

function verifyDependencies(directory = root) {
  const lock = readJson(path.join(directory, 'package-lock.json'))
  for (const [location, pkg] of Object.entries(lock.packages)) {
    const name = pkg.name ?? location.slice(location.lastIndexOf('node_modules/') + 13)
    checkComponent(name, pkg.version, `lock:${location}`)
  }
  // Inspect actual package folders too: a stale or extraneous installation
  // need not be represented by package-lock.json or node_modules/.package-lock.
  let count = 0
  function installed(modules) {
    for (const entry of fs.readdirSync(modules, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const folder = path.join(modules, entry.name)
      if (entry.name.startsWith('@')) {
        installed(folder)
        continue
      }
      const pkg = readJson(path.join(folder, 'package.json'))
      checkComponent(pkg.name, pkg.version, folder)
      count++
      const nested = path.join(folder, 'node_modules')
      if (fs.existsSync(nested)) installed(nested)
    }
  }
  installed(path.join(directory, 'node_modules'))
  for (const name of Object.keys({
    ...readJson(path.join(directory, 'package.json')).dependencies,
    ...readJson(path.join(directory, 'package.json')).devDependencies
  })) {
    if (!fs.existsSync(path.join(directory, 'node_modules', name, 'package.json'))) {
      throw new Error(`Required dependency is missing: ${name}`)
    }
  }
  return count
}

function verifyPackage(directory) {
  let archives = 0
  let files = 0
  let nativeClient = false
  let nativeVersions = false
  function checkPath(file) {
    if (archiveBinary.test(path.basename(file))) {
      throw new Error(`Unexpected archive tool in application: ${file}`)
    }
  }
  function walk(folder) {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name)
      checkPath(file)
      // macOS bundles have symlinks; their real targets are inspected once.
      if (entry.isDirectory()) walk(file)
      if (!entry.isFile()) continue
      files++
      if (/^td-rdp(?:\.exe)?$/.test(entry.name)) nativeClient = true
      if (entry.name === 'native-versions.json' && path.basename(folder) === 'freerdp') {
        checkNativeVersions(readJson(file), file)
        nativeVersions = true
      }
      if (entry.name === 'package.json') {
        const pkg = readJson(file)
        checkComponent(pkg.name, pkg.version, file)
      }
      if (!entry.name.endsWith('.asar')) continue
      // Resolve through the packager that declares this dependency, rather
      // than assuming npm hoisted its copy into our node_modules root.
      const asar = createRequire(require.resolve('app-builder-lib/package.json'))('@electron/asar')
      archives++
      for (const member of asar.listPackage(file)) {
        checkPath(member)
        if (path.basename(member) !== 'package.json') continue
        const pkg = JSON.parse(asar.extractFile(file, member.replace(/^[/\\]/, '')).toString())
        checkComponent(pkg.name, pkg.version, `${file}:${member}`)
      }
    }
  }
  walk(directory)
  if (archives === 0)
    throw new Error(`${directory}: no application ASAR found; check is incomplete`)
  if (nativeClient && !nativeVersions) throw new Error(`${directory}: missing native-versions.json`)
  return { files, archives }
}

module.exports = { checkComponent, checkNativeVersions, verifyDependencies, verifyPackage }

if (require.main === module) {
  try {
    const args = process.argv.slice(2)
    if (args.length) {
      if (args.length !== 2 || args[0] !== '--package') {
        throw new Error('Usage: verify-security.cjs [--package unpacked-application-directory]')
      }
      const { files, archives } = verifyPackage(path.resolve(args[1]))
      process.stdout.write(
        `Security: checked ${files} application files and ${archives} ASAR archives\n`
      )
    } else {
      const count = verifyDependencies()
      process.stdout.write(
        `Security: lock file and ${count} installed packages passed component checks\n`
      )
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  }
}
