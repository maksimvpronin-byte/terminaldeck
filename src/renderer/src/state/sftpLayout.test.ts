import { describe, it, expect } from 'vitest'
import {
  COLUMNS,
  DEFAULT_COLUMNS,
  MAX_COL,
  MIN_COL,
  PANEL_DEFAULT,
  PANEL_MAX,
  PANEL_MIN,
  clamp,
  columnsFrom,
  minRowWidth,
  minWidthOf,
  numberFrom
} from './sftpLayout'

describe('a width read back from a previous run', () => {
  it('is used when it is sane', () => {
    expect(numberFrom('400', PANEL_DEFAULT, PANEL_MIN, PANEL_MAX)).toBe(400)
  })

  it('falls back when there is nothing stored', () => {
    expect(numberFrom(null, PANEL_DEFAULT, PANEL_MIN, PANEL_MAX)).toBe(PANEL_DEFAULT)
  })

  /** localStorage holds strings, and anything can end up in one. */
  it('falls back on rubbish rather than laying out to NaN pixels', () => {
    expect(numberFrom('wide', PANEL_DEFAULT, PANEL_MIN, PANEL_MAX)).toBe(PANEL_DEFAULT)
    expect(numberFrom('', PANEL_DEFAULT, PANEL_MIN, PANEL_MAX)).toBe(PANEL_DEFAULT)
    expect(numberFrom('-40', PANEL_DEFAULT, PANEL_MIN, PANEL_MAX)).toBe(PANEL_DEFAULT)
  })

  /**
   * A panel dragged wide on a large screen must not open off the edge of a
   * small one, and one saved before a minimum was raised must not open unusably
   * narrow.
   */
  it('is brought back inside the range it is allowed', () => {
    expect(numberFrom('9000', PANEL_DEFAULT, PANEL_MIN, PANEL_MAX)).toBe(PANEL_MAX)
    expect(numberFrom('10', PANEL_DEFAULT, PANEL_MIN, PANEL_MAX)).toBe(PANEL_MIN)
  })
})

describe('column widths read back from a previous run', () => {
  it('are the stock ones when nothing was stored', () => {
    expect(columnsFrom(null)).toEqual(DEFAULT_COLUMNS)
  })

  it('are the stock ones when what was stored is not JSON', () => {
    expect(columnsFrom('{ not json')).toEqual(DEFAULT_COLUMNS)
  })

  it('replace only the columns that were actually saved', () => {
    const columns = columnsFrom(JSON.stringify({ size: 120 }))

    expect(columns.size).toBe(120)
    expect(columns.name).toBe(DEFAULT_COLUMNS.name)
  })

  /** A layout saved before the name column could be dragged has no entry for it. */
  it('keep the default for a column the saved layout had never heard of', () => {
    const columns = columnsFrom(JSON.stringify({ owner: 80, group: 80 }))

    expect(columns.name).toBe(DEFAULT_COLUMNS.name)
    expect(columns.owner).toBe(80)
  })

  it('are each brought back inside their own limits', () => {
    const columns = columnsFrom(JSON.stringify({ size: 5000, owner: 1, name: 1 }))

    expect(columns.size).toBe(MAX_COL)
    expect(columns.owner).toBe(MIN_COL)
    // The name has a floor of its own: narrower than that and it shows nothing.
    expect(columns.name).toBe(minWidthOf('name'))
    expect(columns.name).toBeGreaterThan(MIN_COL)
  })

  it('ignore an entry that is not a number', () => {
    expect(columnsFrom(JSON.stringify({ size: 'wide' })).size).toBe(DEFAULT_COLUMNS.size)
  })
})

describe('the panel geometry', () => {
  it('opens wide enough for every stock column, so nothing is cut off', () => {
    expect(minRowWidth(DEFAULT_COLUMNS)).toBeLessThanOrEqual(PANEL_DEFAULT)
  })

  it('grows a row by exactly what a column grew by', () => {
    const wider = { ...DEFAULT_COLUMNS, name: DEFAULT_COLUMNS.name + 100 }

    expect(minRowWidth(wider)).toBe(minRowWidth(DEFAULT_COLUMNS) + 100)
  })

  it('draws the same six columns in the header and the rows', () => {
    expect(COLUMNS.map(([key]) => key).sort()).toEqual(Object.keys(DEFAULT_COLUMNS).sort())
  })

  it('clamps both ways', () => {
    expect(clamp(5, 10, 20)).toBe(10)
    expect(clamp(25, 10, 20)).toBe(20)
    expect(clamp(15, 10, 20)).toBe(15)
  })
})
