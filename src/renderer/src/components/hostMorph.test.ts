import { describe, it, expect } from 'vitest'
import { makeLeaf } from '../state/paneTree'
import { firstVisible, hostOfLeaf, hostOfTab } from './hostMorph'

/** The tree's scrolling area: 400 points tall, starting 100 down. */
const tree = { left: 0, top: 100, width: 260, height: 400 }
const row = (top: number) => ({ left: 6, top, width: 248, height: 28 })

describe('where a closing window lands', () => {
  it('takes the first copy of a row that can be seen', () => {
    // Scrolled above, inside, and below the tree: only the middle one is there.
    const above = row(40)
    const inside = row(300)
    const below = row(560)
    expect(firstVisible([above, inside, below], tree)).toBe(inside)
  })

  it('counts a row half out of view by where its middle is', () => {
    expect(firstVisible([row(90)], tree)).toBeDefined()
    expect(firstVisible([row(70)], tree)).toBeUndefined()
  })

  it('never lands on a row that is not laid out, such as one in a hidden sidebar tab', () => {
    expect(firstVisible([{ left: 0, top: 0, width: 0, height: 0 }], tree)).toBeUndefined()
  })
})

describe('the host a window belongs to', () => {
  it('names the saved host of a tab, so its row can be found', () => {
    const leaf = makeLeaf('web-1', { kind: 'session', sessionId: 'h1' }, '#f00')
    const tab = { id: 't', title: 'web-1 · console', root: leaf, activePaneId: leaf.id }
    expect(hostOfTab(tab)).toEqual({ sessionId: 'h1', title: 'web-1', colour: '#f00' })
  })

  it('has no row for a quick connection', () => {
    const leaf = makeLeaf('me@box', {
      kind: 'quick',
      params: { host: 'box', port: 22, username: 'me' }
    } as never)
    expect(hostOfLeaf(leaf).sessionId).toBeUndefined()
  })
})
