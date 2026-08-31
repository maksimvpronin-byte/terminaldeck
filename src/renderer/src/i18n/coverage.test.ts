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
  for (const file of sourceFiles(RENDERER)) {
    const text = codeOnly(readFileSync(file, 'utf8'))
    for (const match of text.matchAll(/(?<![\w.$])t\(\s*'((?:[^'\\]|\\.)*)'/g)) {
      const key = match[1].replace(/\\'/g, "'")
      found.set(key, [...(found.get(key) ?? []), file.slice(RENDERER.length + 1)])
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
