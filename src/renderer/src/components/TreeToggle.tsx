import type { CSSProperties, MouseEvent as ReactMouseEvent, ReactNode } from 'react'
import { GUIDE_OFFSET } from './treeIndent'

/**
 * What says a folder in a host tree is open, in three places at once.
 *
 * It used to be a nine-pixel ▸ in the dim colour, turned a quarter when open,
 * in front of a folder that looked the same either way — in a tree of twenty
 * groups nobody could tell at a glance which were open. Now the arrow is big
 * enough to see and brightens with its row, the folder itself opens, and what
 * is inside an open folder hangs from a line under its arrow, so the eye can
 * follow where a group ends without counting indents.
 */
export function Chevron({ open }: { open: boolean }): JSX.Element {
  return (
    <span className={`chevron ${open ? 'open' : ''}`} aria-hidden="true">
      <svg width="12" height="12" viewBox="0 0 12 12">
        <path
          d="M4.5 2.5 8 6 4.5 9.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  )
}

/**
 * Whether a click on a folder row should open or close it.
 *
 * Anywhere on the row, unless Settings says the arrow alone does it — then
 * only a click that landed on the arrow.
 */
export function togglesFolder(e: ReactMouseEvent, arrowOnly: boolean): boolean {
  if (!arrowOnly) return true
  return e.target instanceof Element && e.target.closest('.chevron') !== null
}

export function FolderIcon({ open }: { open: boolean }): JSX.Element {
  return (
    <span className="folder-icon" aria-hidden="true">
      {open ? '📂' : '📁'}
    </span>
  )
}

/**
 * The contents of an open folder, with the guide line down their left.
 * `indent` is the folder row's own left padding; the line falls under the
 * middle of its arrow.
 */
export function TreeChildren({
  indent,
  children
}: {
  indent: number
  children: ReactNode
}): JSX.Element {
  return (
    <div
      className="tree-children"
      style={{ '--guide-x': `${indent + GUIDE_OFFSET}px` } as CSSProperties}
    >
      {children}
    </div>
  )
}
