import { readFileSync } from 'fs'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  MAX_RELEASES,
  compareVersions,
  localise,
  markSeen,
  notesFor,
  notesStartAfter,
  parseBlocks,
  parseChangelog,
  parseInline,
  releasesBetween
} from './whatsNew'

const SAMPLE = `# Changelog

Intro with a [link](README.md).

## 1.2.0

### Added

- **Bold thing.** Runs on
  over two lines.
  - Nested \`code\`.

## 1.1.0

Just a paragraph.

## Older

## 1.0.0

- One.
`

describe('parseChangelog', () => {
  it('splits versioned entries and drops the intro and unversioned headings', () => {
    const releases = parseChangelog(SAMPLE)
    expect(releases.map((r) => r.version)).toEqual(['1.2.0', '1.1.0', '1.0.0'])
    expect(releases[1].body).toBe('Just a paragraph.')
  })

  it('reads the real changelogs, newest first, and every Russian version exists in English', () => {
    const en = parseChangelog(readFileSync('CHANGELOG.md', 'utf-8'))
    const ru = parseChangelog(readFileSync('CHANGELOG.ru.md', 'utf-8'))
    const version = JSON.parse(readFileSync('package.json', 'utf-8')).version as string
    expect(en[0].version).toBe(version)
    const known = new Set(en.map((r) => r.version))
    for (const r of ru) expect(known.has(r.version)).toBe(true)
  })
})

describe('compareVersions', () => {
  it('orders numerically, not as text', () => {
    expect(compareVersions('0.10.0', '0.9.9')).toBeGreaterThan(0)
    expect(compareVersions('0.20.1', '0.20.1')).toBe(0)
    expect(compareVersions('0.0.0-test', '0.0.0')).toBe(0)
  })
})

describe('releasesBetween', () => {
  const releases = parseChangelog(SAMPLE)

  it('takes what came after the seen version, up to the running one', () => {
    expect(releasesBetween(releases, '1.0.0', '1.2.0').map((r) => r.version)).toEqual([
      '1.2.0',
      '1.1.0'
    ])
    expect(releasesBetween(releases, '1.0.0', '1.1.0').map((r) => r.version)).toEqual(['1.1.0'])
  })

  it('stops after a handful', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ version: `0.${i}.0`, body: '' }))
    expect(releasesBetween(many, '0.0.0', '9.0.0')).toHaveLength(MAX_RELEASES)
  })
})

describe('localise', () => {
  it('prefers the translated entry and falls back to English', () => {
    const en = [
      { version: '2.0.0', body: 'en2' },
      { version: '1.0.0', body: 'en1' }
    ]
    const out = localise(en, [{ version: '2.0.0', body: 'ru2' }])
    expect(out.map((r) => r.body)).toEqual(['ru2', 'en1'])
  })
})

describe('parseBlocks', () => {
  it('reads headings, continued and nested items, and inline marks', () => {
    const body = parseChangelog(SAMPLE)[0].body
    expect(parseBlocks(body)).toEqual([
      { kind: 'heading', text: [{ kind: 'text', text: 'Added' }] },
      {
        kind: 'item',
        depth: 0,
        text: [
          { kind: 'bold', text: 'Bold thing.' },
          { kind: 'text', text: ' Runs on over two lines.' }
        ]
      },
      {
        kind: 'item',
        depth: 1,
        text: [
          { kind: 'text', text: 'Nested ' },
          { kind: 'code', text: 'code' },
          { kind: 'text', text: '.' }
        ]
      }
    ])
  })

  it('keeps a link’s words and drops its address', () => {
    expect(parseInline('see [Releasing](README.md#releasing) now')).toEqual([
      { kind: 'text', text: 'see ' },
      { kind: 'text', text: 'Releasing' },
      { kind: 'text', text: ' now' }
    ])
  })
})

describe('notesStartAfter', () => {
  const store = new Map<string, string>()
  beforeEach(() => {
    store.clear()
    globalThis.localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v)
    } as Storage
  })

  it('tells a new install nothing', () => {
    expect(notesStartAfter('0.20.1')).toBeNull()
  })

  it('tells an installation from before this existed the running version alone', () => {
    store.set('terminaldeck.terminalSettings', '{}')
    expect(notesStartAfter('0.20.1')).toBe('0.20.0')
    expect(notesFor('en', '0.20.0', '0.20.1').map((r) => r.version)).toEqual(['0.20.1'])
  })

  it('starts after the version last seen, and is quiet once this one is', () => {
    markSeen('0.19.9')
    expect(notesStartAfter('0.20.1')).toBe('0.19.9')
    markSeen('0.20.1')
    expect(notesStartAfter('0.20.1')).toBeNull()
  })

  it('tells Russian readers in Russian where there is a Russian entry', () => {
    const [latest] = notesFor('ru', '0.20.0', '0.20.1')
    expect(latest.body).toMatch(/Добавлено/)
  })
})
