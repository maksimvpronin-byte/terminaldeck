/**
 * How wide everything in the SFTP panel is, and what of that survives a restart.
 *
 * Lifted out of the panel itself, which knew four localStorage keys, wrote to
 * them from five places, and carried a hundred lines of arithmetic that has
 * nothing to do with SFTP. The reading and writing stay behind the functions at
 * the bottom; everything above them is pure, and tested.
 */

const WIDTH_KEY = 'sftp.panelWidth'
const TREE_KEY = 'sftp.treeOpen'
const TREE_WIDTH_KEY = 'sftp.treeWidth'
const COLS_KEY = 'sftp.columnWidths'

/** Narrow enough to still show a name; wide enough for every column. */
export const PANEL_MIN = 260
export const PANEL_MAX = 1400
/**
 * Wide enough to hold `DEFAULT_COLUMNS` without scrolling sideways, with room
 * left for the vertical scrollbar — which any listing longer than the panel
 * puts there, and which would otherwise squeeze the last column back out.
 */
export const PANEL_DEFAULT = 680

export const TREE_MIN = 120
export const TREE_MAX = 600
export const TREE_DEFAULT = 190

export const MIN_COL = 44
/** Generous enough for a long name or a full path, short of silly. */
export const MAX_COL = 600
/** A name column narrower than this shows nothing useful, so dragging stops here. */
const NAME_MIN = 90

/** Must match the row's `gap` and horizontal `padding`. */
const ROW_GAP = 10
const ROW_PADDING = 16

export interface ColumnWidths {
  name: number
  size: number
  changed: number
  perms: number
  owner: number
  group: number
}

/**
 * Chosen to add up — with the gaps and padding — to just under `PANEL_DEFAULT`,
 * so a panel nobody has resized shows all six columns instead of opening on a
 * horizontal scrollbar with the last one already cut in half.
 */
export const DEFAULT_COLUMNS: ColumnWidths = {
  name: 200,
  size: 62,
  changed: 124,
  perms: 76,
  owner: 64,
  group: 64
}

/**
 * Header order, which is also row order — the two are drawn from this list.
 *
 * The labels are English keys for the phrase book, not text: the panel puts
 * them through `t()`.
 */
export const COLUMNS: [keyof ColumnWidths, string][] = [
  ['name', 'Name'],
  ['size', 'Size'],
  ['changed', 'Changed'],
  ['perms', 'Rights'],
  ['owner', 'Owner'],
  ['group', 'Group']
]

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** The floor a given column may be dragged down to. */
export function minWidthOf(key: keyof ColumnWidths): number {
  return key === 'name' ? NAME_MIN : MIN_COL
}

/**
 * How wide a row has to be for every column to fit.
 *
 * Rows cannot be sized by their content: a long filename would widen that row's
 * name cell and shove the columns after it out of line with every other row. So
 * every column, the name included, is exactly as wide as it was dragged to be,
 * and the listing scrolls sideways when the panel cannot hold them all.
 */
export function minRowWidth(columns: ColumnWidths): number {
  const widths = Object.values(columns)
  const gaps = ROW_GAP * (widths.length - 1)
  return widths.reduce((sum, w) => sum + w, 0) + gaps + ROW_PADDING
}

/** A fixed column: never grows, never shrinks, so the header stays over its rows. */
export function col(width: number): { flex: string; width: number } {
  return { flex: `0 0 ${width}px`, width }
}

/** A stored number, or the fallback when it is missing, spoilt or out of range. */
export function numberFrom(raw: string | null, fallback: number, min: number, max: number): number {
  const stored = Number(raw)
  if (!Number.isFinite(stored) || stored <= 0) return fallback
  return clamp(stored, min, max)
}

/** Stored column widths merged over the defaults, each one kept in range. */
export function columnsFrom(raw: string | null): ColumnWidths {
  try {
    if (!raw) return DEFAULT_COLUMNS
    const stored = JSON.parse(raw) as Partial<ColumnWidths>
    const out = { ...DEFAULT_COLUMNS }
    for (const key of Object.keys(DEFAULT_COLUMNS) as (keyof ColumnWidths)[]) {
      const value = Number(stored[key])
      // A layout saved before the name was resizable simply has no entry for it,
      // and keeps the default.
      if (Number.isFinite(value) && value > 0) out[key] = clamp(value, minWidthOf(key), MAX_COL)
    }
    return out
  } catch {
    // A layout is not worth failing over; fall back to the stock widths.
    return DEFAULT_COLUMNS
  }
}

export function loadPanelWidth(): number {
  return numberFrom(localStorage.getItem(WIDTH_KEY), PANEL_DEFAULT, PANEL_MIN, PANEL_MAX)
}

export function savePanelWidth(px: number): void {
  localStorage.setItem(WIDTH_KEY, String(px))
}

export function loadTreeWidth(): number {
  return numberFrom(localStorage.getItem(TREE_WIDTH_KEY), TREE_DEFAULT, TREE_MIN, TREE_MAX)
}

export function saveTreeWidth(px: number): void {
  localStorage.setItem(TREE_WIDTH_KEY, String(px))
}

export function loadColumns(): ColumnWidths {
  return columnsFrom(localStorage.getItem(COLS_KEY))
}

export function saveColumns(columns: ColumnWidths): void {
  localStorage.setItem(COLS_KEY, JSON.stringify(columns))
}

/** Open unless it was explicitly closed, so a first run shows the tree. */
export function loadTreeOpen(): boolean {
  return localStorage.getItem(TREE_KEY) !== 'false'
}

export function saveTreeOpen(open: boolean): void {
  localStorage.setItem(TREE_KEY, String(open))
}
