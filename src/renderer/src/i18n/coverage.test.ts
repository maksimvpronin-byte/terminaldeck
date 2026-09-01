import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { ru } from './ru'

const RENDERER = join(dirname(fileURLToPath(import.meta.url)), '..')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) return sourceFiles(full)
    return /\.tsx?$/.test(name) && !name.endsWith('.test.ts') ? [full] : []
  })
}

/** Prose that talks about the code is not the code. */
function codeOnly(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ')
}

/**
 * Every phrase the interface asks for, as written in the source.
 *
 * The guard against `useState('')` and `endsWith('/')` is the lookbehind: a
 * bare `t(`, not the tail of a longer name. Comments are stripped first, or a
 * doc comment explaining this very function would enter the phrase book. A key
 * built at runtime is invisible here and stays untranslated, which is why they
 * are not built at runtime.
 */
function keysAskedFor(): Map<string, string[]> {
  const found = new Map<string, string[]>()
  const add = (key: string, file: string): void => {
    found.set(key, [...(found.get(key) ?? []), file.slice(RENDERER.length + 1)])
  }

  for (const file of sourceFiles(RENDERER)) {
    const text = codeOnly(readFileSync(file, 'utf8'))

    /**
     * Both quote styles, and the second one is not a nicety.
     *
     * This read single quotes only, which sounds harmless until you notice
     * *which* strings get written with double quotes: the ones containing an
     * apostrophe. "the host's own login" and "Counted in the screen's own
     * pixels" were invisible to this test for exactly that reason, and so was
     * every other string in the four files that happen to be formatted with
     * double quotes — sixty-two of them.
     */
    for (const match of text.matchAll(/(?<![\w.$])t\(\s*'((?:[^'\\]|\\.)*)'/g)) {
      add(match[1].replace(/\\'/g, "'"), file)
    }
    for (const match of text.matchAll(/(?<![\w.$])t\(\s*"((?:[^"\\]|\\.)*)"/g)) {
      add(match[1].replace(/\\"/g, '"'), file)
    }

    /**
     * The help dialog, which asks for its phrases through a variable.
     *
     * It holds its rows as data and renders them with `t(row.what)`, so the key
     * is never written next to the call and nothing above can see it. That is
     * a hundred and thirty-three phrases — by some way the largest single
     * screen in the application — and two of them had gone untranslated
     * without this test having anything to say about it.
     */
    if (file.endsWith('HelpDialog.tsx')) {
      for (const match of text.matchAll(/(?:what|title):\s*'((?:[^'\\]|\\.)*)'/g)) {
        add(match[1].replace(/\\'/g, "'"), file)
      }
      for (const match of text.matchAll(/(?:what|title):\s*"((?:[^"\\]|\\.)*)"/g)) {
        add(match[1].replace(/\\"/g, '"'), file)
      }
    }
  }
  return found
}

describe('the Russian phrase book', () => {
  /**
   * A missing entry falls back to English, which is a working screen — so
   * nothing breaks, and nothing says anything either. This is what says it.
   */
  it('has an entry for every phrase the interface asks for', () => {
    const missing = [...keysAskedFor()]
      .filter(([key]) => !(key in ru))
      .map(([key, files]) => `${files[0]}: ${key}`)

    expect(missing).toEqual([])
  })

  /**
   * The other direction, which nothing was watching.
   *
   * Thirteen entries outlived the desktop client they were written for — its
   * error kinds, its file-transfer offer, two labels from a pane that no longer
   * exists — and sat in the phrase book looking like work that had been done.
   *
   * If this fires for a phrase the interface really does use, the interface is
   * asking for it in a way `keysAskedFor` cannot see: a key built at runtime,
   * or a new screen that keeps its text as data the way the help dialog does.
   * Teach the reader about it rather than deleting the entry.
   */
  it('has nothing left over that the interface no longer asks for', () => {
    const asked = new Set(keysAskedFor().keys())
    const stale = Object.keys(ru).filter((key) => !asked.has(key))

    expect(stale).toEqual([])
  })

  it('carries the same placeholders across into the translation', () => {
    const placeholders = (text: string): string[] =>
      [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()

    const mismatched = Object.entries(ru)
      .filter(([key, value]) => placeholders(key).join() !== placeholders(value).join())
      .map(([key]) => key)

    // A translation that drops `{version}` prints a sentence with a hole in it;
    // one that invents `{verison}` prints the brace.
    expect(mismatched).toEqual([])
  })
})
