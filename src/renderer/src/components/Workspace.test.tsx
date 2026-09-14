// @vitest-environment jsdom
import { it, expect, vi } from 'vitest'
import { createEvent, fireEvent, render } from '@testing-library/react'
import { useStore } from '../state/store'
import { makeLeaf } from '../state/paneTree'
import { DRAG_MIME } from '../state/dnd'
import Workspace from './Workspace'

vi.mock('./SplitContainer', () => ({ default: () => <div /> }))

it('reorders tabs by dragging one into the gap beside another', () => {
  const tab = (id: string) => {
    const root = makeLeaf(id, { kind: 'session', sessionId: id })
    return { id, title: id, root, activePaneId: root.id }
  }
  useStore.setState({
    activeWorkspaceId: 'w',
    workspaces: [{ id: 'w', title: 'work', activeTabId: 'a', tabs: ['a', 'b', 'c'].map(tab) }]
  })
  const view = render(<Workspace />)
  const tabs = (): HTMLElement[] => [...view.container.querySelectorAll<HTMLElement>('.tab')]
  // Every tab a hundred points wide, laid side by side.
  tabs().forEach((el, i) => {
    el.getBoundingClientRect = () => ({ left: i * 100, width: 100 }) as DOMRect
  })

  const data = new Map<string, string>()
  const dataTransfer = {
    types: [DRAG_MIME],
    setData: (k: string, v: string) => data.set(k, v),
    getData: (k: string) => data.get(k) ?? ''
  }
  // jsdom has no DragEvent, so the pointer position has to be put on by hand.
  const at = (type: 'dragOver' | 'drop', el: HTMLElement, clientX: number): void => {
    const event = createEvent[type](el, { dataTransfer })
    Object.defineProperty(event, 'clientX', { value: clientX })
    fireEvent(el, event)
  }
  const [a, , c] = tabs()
  fireEvent.dragStart(c, { dataTransfer })
  at('dragOver', a, 80)
  expect(a.className).toContain('drop-after')
  at('dragOver', a, 20)
  expect(a.className).toContain('drop-before')
  at('drop', a, 20)
  fireEvent.dragEnd(c, { dataTransfer })

  expect(useStore.getState().workspaces[0].tabs.map((t) => t.id)).toEqual(['c', 'a', 'b'])
  expect(tabs().map((el) => el.textContent)).toEqual(['c✕', 'a✕', 'b✕'])
  expect(view.container.querySelector('.drop-before, .drop-after, .dragging')).toBeNull()
})
