// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { createEvent, fireEvent, render, screen } from '@testing-library/react'
import Sidebar from './Sidebar'
import { moveSection, normaliseOrder } from './TreeSection'
import { useStore } from '../state/store'

describe('the order of the sections', () => {
  it('fills in what a stored order lacks and drops what it should not hold', () => {
    expect(normaliseOrder(undefined)).toEqual(['inventory', 'collections', 'multiWindows'])
    expect(normaliseOrder(['multiWindows', 'bogus', 'multiWindows'])).toEqual([
      'multiWindows',
      'inventory',
      'collections'
    ])
    expect(normaliseOrder('nonsense')).toEqual(['inventory', 'collections', 'multiWindows'])
  })

  it('puts a dragged section on the side of the one it is let go on', () => {
    const order = normaliseOrder(undefined)
    expect(moveSection(order, 'multiWindows', 'inventory', 'before')).toEqual([
      'multiWindows',
      'inventory',
      'collections'
    ])
    expect(moveSection(order, 'inventory', 'collections', 'after')).toEqual([
      'collections',
      'inventory',
      'multiWindows'
    ])
    expect(moveSection(order, 'collections', 'collections', 'before')).toBe(order)
  })
})

function headings(): string[] {
  return [...document.querySelectorAll('.section-heading .section-title')].map(
    (el) => el.textContent ?? ''
  )
}

function heading(title: string): HTMLElement {
  const el = [...document.querySelectorAll<HTMLElement>('.section-heading')].find(
    (h) => h.querySelector('.section-title')?.textContent === title
  )
  if (!el) throw new Error(`no heading ${title}`)
  return el
}

/** What the browser hands each drag event: one object, carried from start to drop. */
function transfer(): DataTransfer {
  const data: Record<string, string> = {}
  return {
    setData: (k: string, v: string) => {
      data[k] = v
    },
    getData: (k: string) => data[k] ?? '',
    get types() {
      return Object.keys(data)
    },
    effectAllowed: 'all',
    dropEffect: 'none'
  } as unknown as DataTransfer
}

/** jsdom's drag events carry no pointer position of their own; this one does. */
function dragAt(
  kind: 'dragOver' | 'drop',
  el: HTMLElement,
  dataTransfer: DataTransfer,
  y: number
): void {
  const event = createEvent[kind](el, { dataTransfer })
  Object.defineProperty(event, 'clientY', { value: y })
  fireEvent(el, event)
}

describe('the sections under the host tree', () => {
  beforeEach(() => {
    localStorage.clear()
    useStore.setState({
      sessions: [],
      groups: [],
      gitFolderTrees: [],
      gitFolderOverrides: [],
      inventorySources: [],
      inventoryTrees: [],
      inventoryOverrides: [],
      collections: [],
      multiWindows: [],
      loadInventory: async () => {},
      loadCollections: async () => {},
      loadMultiWindows: async () => {},
      selectedHostIds: [],
      hostMenuRequest: null
    })
  })

  it('folds a whole section from its heading, and keeps it folded', () => {
    const { unmount } = render(<Sidebar onOpenSnippets={() => {}} onOpenHelp={() => {}} />)
    expect(screen.getByText(/Your own sets of hosts/)).toBeTruthy()

    fireEvent.click(heading('Collections'))
    expect(screen.queryByText(/Your own sets of hosts/)).toBeNull()
    expect(heading('Collections').getAttribute('aria-expanded')).toBe('false')

    unmount()
    render(<Sidebar onOpenSnippets={() => {}} onOpenHelp={() => {}} />)
    expect(screen.queryByText(/Your own sets of hosts/)).toBeNull()

    // Expand all leaves nothing hidden.
    fireEvent.click(screen.getByLabelText('Expand all'))
    expect(screen.getByText(/Your own sets of hosts/)).toBeTruthy()
  })

  it('leaves a section open when its + is pressed', () => {
    render(<Sidebar onOpenSnippets={() => {}} onOpenHelp={() => {}} />)
    fireEvent.click(screen.getByTitle('New collection'))
    expect(heading('Collections').getAttribute('aria-expanded')).toBe('true')
  })

  it('moves a section by dragging its heading over another, and remembers it', () => {
    const { unmount } = render(<Sidebar onOpenSnippets={() => {}} onOpenHelp={() => {}} />)
    expect(headings()).toEqual(['Inventory', 'Collections', 'Multi-windows'])

    const target = heading('Inventory').closest('.tree-section') as HTMLElement
    target.getBoundingClientRect = () =>
      ({ top: 0, bottom: 100, height: 100, left: 0, right: 0, width: 0 }) as DOMRect
    const dataTransfer = transfer()
    fireEvent.dragStart(heading('Multi-windows'), { dataTransfer })
    dragAt('dragOver', target, dataTransfer, 10)
    expect(target.classList.contains('drop-before')).toBe(true)
    dragAt('drop', target, dataTransfer, 10)

    expect(headings()).toEqual(['Multi-windows', 'Inventory', 'Collections'])
    unmount()
    render(<Sidebar onOpenSnippets={() => {}} onOpenHelp={() => {}} />)
    expect(headings()).toEqual(['Multi-windows', 'Inventory', 'Collections'])
  })
})
