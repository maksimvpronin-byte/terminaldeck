export type DiffLine =
  | { kind: 'same'; text: string; leftNo: number; rightNo: number }
  | { kind: 'added'; text: string; rightNo: number }
  | { kind: 'removed'; text: string; leftNo: number }

export interface DiffResult {
  lines: DiffLine[]
  added: number
  removed: number
  /** The two sides match apart from CRLF vs LF. */
  onlyLineEndings: boolean
  /** Too big to diff precisely, so the difference is reported as one block. */
  coarse: boolean
}

/**
 * The quadratic table is bounded: beyond this many cells the file is reported
 * as wholly replaced rather than locking the window for a precise answer
 * nobody would read line by line anyway.
 */
const MAX_CELLS = 4_000_000

function splitLines(text: string): string[] {
  // A trailing newline would otherwise show as a phantom empty last line.
  const normalized = text.replace(/\r\n/g, '\n')
  const lines = normalized.split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/**
 * A line diff, LCS over the middle after the shared head and tail are trimmed.
 *
 * Written out rather than pulled in: it is forty lines of the kind of pure
 * logic this repo tests anyway, and a dependency here would be carried into
 * every build for one dialog.
 */
export function diffLines(left: string, right: string): DiffResult {
  const sameIgnoringEndings = left.replace(/\r\n/g, '\n') === right.replace(/\r\n/g, '\n')
  const a = splitLines(left)
  const b = splitLines(right)

  if (sameIgnoringEndings) {
    return {
      lines: a.map((text, i) => ({ kind: 'same', text, leftNo: i + 1, rightNo: i + 1 })),
      added: 0,
      removed: 0,
      onlyLineEndings: left !== right,
      coarse: false
    }
  }

  // Trim the common head and tail; a one-line change in a large file then costs
  // almost nothing.
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail++
  }

  const midA = a.slice(head, a.length - tail)
  const midB = b.slice(head, b.length - tail)
  const lines: DiffLine[] = []
  let added = 0
  let removed = 0

  for (let i = 0; i < head; i++) {
    lines.push({ kind: 'same', text: a[i], leftNo: i + 1, rightNo: i + 1 })
  }

  const coarse = midA.length * midB.length > MAX_CELLS
  if (coarse) {
    midA.forEach((text, i) => lines.push({ kind: 'removed', text, leftNo: head + i + 1 }))
    midB.forEach((text, i) => lines.push({ kind: 'added', text, rightNo: head + i + 1 }))
    removed += midA.length
    added += midB.length
  } else {
    // lcs[i][j] — longest common subsequence of midA[i..] and midB[j..].
    const lcs: number[][] = Array.from({ length: midA.length + 1 }, () =>
      new Array<number>(midB.length + 1).fill(0)
    )
    for (let i = midA.length - 1; i >= 0; i--) {
      for (let j = midB.length - 1; j >= 0; j--) {
        lcs[i][j] =
          midA[i] === midB[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
      }
    }

    let i = 0
    let j = 0
    while (i < midA.length && j < midB.length) {
      if (midA[i] === midB[j]) {
        lines.push({
          kind: 'same',
          text: midA[i],
          leftNo: head + i + 1,
          rightNo: head + j + 1
        })
        i++
        j++
      } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
        lines.push({ kind: 'removed', text: midA[i], leftNo: head + i + 1 })
        removed++
        i++
      } else {
        lines.push({ kind: 'added', text: midB[j], rightNo: head + j + 1 })
        added++
        j++
      }
    }
    while (i < midA.length) {
      lines.push({ kind: 'removed', text: midA[i], leftNo: head + i + 1 })
      removed++
      i++
    }
    while (j < midB.length) {
      lines.push({ kind: 'added', text: midB[j], rightNo: head + j + 1 })
      added++
      j++
    }
  }

  for (let k = 0; k < tail; k++) {
    lines.push({
      kind: 'same',
      text: a[a.length - tail + k],
      leftNo: a.length - tail + k + 1,
      rightNo: b.length - tail + k + 1
    })
  }

  return { lines, added, removed, onlyLineEndings: false, coarse }
}

/**
 * Hides long stretches of unchanged lines, keeping `context` on each side of a
 * change. Returns the lines to draw, with gaps marked so the view can say how
 * much it folded away.
 */
export type DiffRow = { kind: 'gap'; hidden: number } | { kind: 'line'; line: DiffLine }

export function collapseUnchanged(lines: DiffLine[], context = 3): DiffRow[] {
  const keep = new Array<boolean>(lines.length).fill(false)
  lines.forEach((line, i) => {
    if (line.kind === 'same') return
    for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) {
      keep[k] = true
    }
  })

  const rows: DiffRow[] = []
  let hidden = 0
  for (let i = 0; i < lines.length; i++) {
    if (keep[i]) {
      if (hidden > 0) {
        rows.push({ kind: 'gap', hidden })
        hidden = 0
      }
      rows.push({ kind: 'line', line: lines[i] })
    } else {
      hidden++
    }
  }
  if (hidden > 0) rows.push({ kind: 'gap', hidden })
  return rows
}
