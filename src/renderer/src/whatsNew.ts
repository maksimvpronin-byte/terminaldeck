import changelogEn from '../../../CHANGELOG.md?raw'
import changelogRu from '../../../CHANGELOG.ru.md?raw'
import type { Language } from './i18n'

/**
 * What a release brought, told once after the app has updated itself to it.
 *
 * The notes come from the changelogs built into the app, not from the release
 * page: they are there offline, they match the build that is running, and they
 * are the same words the release was written up in. The Russian changelog is
 * kept beside the English one; a version it has no entry for is told in
 * English rather than not at all.
 */

export interface Release {
  version: string
  /** The entry's Markdown, without its `## x.y.z` heading. */
  body: string
}

/** Every `## x.y.z` entry of a changelog, in the order written — newest first. */
export function parseChangelog(markdown: string): Release[] {
  const releases: Release[] = []
  let current: { version: string; lines: string[] } | null = null
  const close = (): void => {
    if (current) releases.push({ version: current.version, body: current.lines.join('\n').trim() })
    current = null
  }
  for (const line of markdown.split(/\r?\n/)) {
    const heading = /^## +(\d+\.\d+\.\d+)\s*$/.exec(line)
    // Any second-level heading ends the entry before it; a version opens one.
    if (/^## /.test(line)) {
      close()
      if (heading) current = { version: heading[1], lines: [] }
    } else if (current) {
      current.lines.push(line)
    }
  }
  close()
  return releases
}

/** Compares two x.y.z versions; anything after a `-` is ignored. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string): number[] =>
    v
      .split('-')[0]
      .split('.')
      .map((n) => Number(n) || 0)
  const [pa, pb] = [parts(a), parts(b)]
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/**
 * Past this many releases the list stops. Someone who skipped a dozen updates
 * wants the gist of the latest few, and the rest is in the changelog.
 */
export const MAX_RELEASES = 5

/** The releases after `from`, up to and including `to`, newest first. */
export function releasesBetween(releases: Release[], from: string, to: string): Release[] {
  return releases
    .filter((r) => compareVersions(r.version, from) > 0 && compareVersions(r.version, to) <= 0)
    .sort((a, b) => compareVersions(b.version, a.version))
    .slice(0, MAX_RELEASES)
}

/**
 * The same releases told in the reader's language: each version from that
 * language's changelog when it has one, from the English one otherwise.
 */
export function localise(releases: Release[], translated: Release[]): Release[] {
  const byVersion = new Map(translated.map((r) => [r.version, r]))
  return releases.map((r) => byVersion.get(r.version) ?? r)
}

const EN = parseChangelog(changelogEn)
const RU = parseChangelog(changelogRu)

/** What changed after `from` up to `to`, in `language`. */
export function notesFor(language: Language, from: string, to: string): Release[] {
  const releases = releasesBetween(EN, from, to)
  return language === 'ru' ? localise(releases, RU) : releases
}

/** The latest few releases up to `to`, for reading again from Help. */
export function recentNotes(language: Language, to: string): Release[] {
  return notesFor(language, '0.0.0', to)
}

// --- Which version was last told about ---

const SEEN_KEY = 'terminaldeck.lastSeenVersion'
/** Written by every version that has run, so its presence means "not a new install". */
const SETTINGS_KEY = 'terminaldeck.terminalSettings'

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

/**
 * The version the notes should start after, or null when there is nothing to
 * tell.
 *
 * A first install has nothing to tell: everything is new, and the app itself
 * is the news. An installation from before this existed has settings but no
 * record of a version seen — that is an update, to this version, and it is
 * told this version's notes alone.
 */
export function notesStartAfter(current: string): string | null {
  const seen = read(SEEN_KEY)
  if (seen === null) {
    if (read(SETTINGS_KEY) === null) return null
    const previous = EN.find((r) => compareVersions(r.version, current) < 0)
    return previous?.version ?? null
  }
  return compareVersions(current, seen) > 0 ? seen : null
}

export function markSeen(version: string): void {
  try {
    localStorage.setItem(SEEN_KEY, version)
  } catch {
    // Told again next launch, which is the lesser harm.
  }
}

// --- The little Markdown the changelogs are written in ---

export type Inline =
  { kind: 'text'; text: string } | { kind: 'bold'; text: string } | { kind: 'code'; text: string }

export type Block =
  | { kind: 'heading'; text: Inline[] }
  | { kind: 'paragraph'; text: Inline[] }
  | { kind: 'item'; depth: number; text: Inline[] }

/** Bold, code and links — a link keeps its words and drops its address. */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = []
  const re = /\*\*(.+?)\*\*|`([^`]+)`|\[([^\]]+)\]\([^)]*\)/g
  let last = 0
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push({ kind: 'text', text: text.slice(last, m.index) })
    if (m[1] !== undefined) out.push({ kind: 'bold', text: m[1] })
    else if (m[2] !== undefined) out.push({ kind: 'code', text: m[2] })
    else out.push({ kind: 'text', text: m[3] })
    last = re.lastIndex
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) })
  return out
}

/**
 * An entry's body as headings, list items and paragraphs. A list item runs on
 * over the indented lines under it; a nested one is indented by two spaces.
 */
export function parseBlocks(body: string): Block[] {
  const blocks: Array<{ kind: Block['kind']; depth: number; lines: string[] }> = []
  let open: (typeof blocks)[number] | null = null
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trimEnd()
    if (!line.trim()) {
      open = null
      continue
    }
    const heading = /^#{3,} +(.*)$/.exec(line)
    const item = /^( *)[-*] +(.*)$/.exec(line)
    if (heading) {
      blocks.push({ kind: 'heading', depth: 0, lines: [heading[1]] })
      open = null
    } else if (item) {
      open = { kind: 'item', depth: Math.floor(item[1].length / 2), lines: [item[2]] }
      blocks.push(open)
    } else if (open) {
      open.lines.push(line.trim())
    } else {
      open = { kind: 'paragraph', depth: 0, lines: [line.trim()] }
      blocks.push(open)
    }
  }
  return blocks.map((b) => {
    const text = parseInline(b.lines.join(' '))
    return b.kind === 'item' ? { kind: 'item', depth: b.depth, text } : { kind: b.kind, text }
  }) as Block[]
}
