const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')
const { createRequire } = require('node:module')
const {
  checkComponent,
  checkNativeVersions,
  verifyDependencies,
  verifyPackage
} = require('./verify-security.cjs')

test('rejects stale native build caches and accepts patched versions', () => {
  assert.throws(() => checkNativeVersions({ freerdp: '3.31.0', zlib: '1.4' }, 'fixture'), /freerdp/)
  assert.throws(() => checkNativeVersions({ freerdp: '3.33.1', zlib: '1.3.2' }, 'fixture'), /zlib/)
  assert.throws(() => checkNativeVersions({ freerdp: '3.33.1' }, 'fixture'), /zlib/)
  assert.doesNotThrow(() => checkNativeVersions({ freerdp: '3.33.1', zlib: '1.4' }, 'fixture'))
})

test('checks both affected minimatch branches without changing older majors', () => {
  for (const version of ['9.0.9', '10.2.6', '11.0.0']) {
    assert.throws(() => checkComponent('minimatch', version, 'fixture'), /GHSA-g3hv/)
  }
  for (const version of ['3.1.5', '5.1.9', '11.0.1', '11.0.8']) {
    assert.doesNotThrow(() => checkComponent('minimatch', version, 'fixture'))
  }
})

test('catches an omitted lock dependency and an extraneous installed dependency', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'td-security-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  fs.mkdirSync(path.join(directory, 'node_modules'))
  fs.writeFileSync(path.join(directory, 'package.json'), '{}')
  const lock = path.join(directory, 'package-lock.json')
  fs.writeFileSync(
    lock,
    JSON.stringify({
      packages: {
        'node_modules/electron-winstaller': { version: '5.4.0', peer: true }
      }
    })
  )
  assert.throws(() => verifyDependencies(directory), /obsolete 7-Zip/)
  fs.writeFileSync(lock, JSON.stringify({ packages: {} }))
  const extra = path.join(directory, 'node_modules', 'stale')
  fs.mkdirSync(extra)
  fs.writeFileSync(
    path.join(extra, 'package.json'),
    JSON.stringify({
      name: 'minimatch',
      version: '9.0.9'
    })
  )
  assert.throws(() => verifyDependencies(directory), /GHSA-g3hv/)
})

test('inspects ASAR members and refuses an empty package scan', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'td-package-security-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const source = path.join(directory, 'source')
  const packaged = path.join(directory, 'packaged')
  fs.mkdirSync(source)
  fs.mkdirSync(packaged)
  assert.throws(() => verifyPackage(packaged), /no application ASAR/)
  fs.writeFileSync(
    path.join(source, 'package.json'),
    JSON.stringify({ name: 'fixture', version: '1.0.0' })
  )
  const asar = createRequire(require.resolve('app-builder-lib/package.json'))('@electron/asar')
  await asar.createPackage(source, path.join(packaged, 'safe.asar'))
  assert.equal(verifyPackage(packaged).archives, 1)
  const native = path.join(packaged, 'freerdp')
  fs.mkdirSync(path.join(native, 'bin'), { recursive: true })
  fs.writeFileSync(path.join(native, 'bin', 'td-rdp.exe'), 'synthetic client, never executed')
  assert.throws(() => verifyPackage(packaged), /missing native-versions/)
  const marker = path.join(native, 'native-versions.json')
  fs.writeFileSync(marker, JSON.stringify({ freerdp: '3.33.1', zlib: '1.3.2' }))
  assert.throws(() => verifyPackage(packaged), /zlib/)
  fs.writeFileSync(marker, JSON.stringify({ freerdp: '3.33.1', zlib: '1.4' }))
  assert.equal(verifyPackage(packaged).archives, 1)
  const nested = path.join(source, 'node_modules', 'minimatch')
  fs.mkdirSync(nested, { recursive: true })
  fs.writeFileSync(
    path.join(nested, 'package.json'),
    JSON.stringify({ name: 'minimatch', version: '10.2.6' })
  )
  const affected = path.join(packaged, 'affected.asar')
  await asar.createPackage(source, affected)
  assert.throws(() => verifyPackage(packaged), /GHSA-g3hv/)
  fs.unlinkSync(affected)
  fs.writeFileSync(path.join(source, '7za.exe'), 'synthetic binary, never executed')
  await asar.createPackage(source, path.join(packaged, 'unsafe.asar'))
  assert.throws(() => verifyPackage(packaged), /Unexpected archive tool/)
})
