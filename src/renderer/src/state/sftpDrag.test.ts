import { describe, it, expect, beforeEach } from 'vitest'
import { SFTP_DRAG, acceptsDrop, beginDrag, draggedNow, endDrag } from './sftpDrag'

beforeEach(endDrag)

describe('what a file panel will take on a drop', () => {
  it('takes files from the desktop', () => {
    expect(acceptsDrop(['Files'], null, 'panel')).toBe(true)
  })

  it('takes rows dragged out of another host’s panel', () => {
    beginDrag({ connectionId: 'other', paths: ['/srv/a.txt'] })

    expect(acceptsDrop([SFTP_DRAG], draggedNow()?.connectionId, 'panel')).toBe(true)
  })

  /**
   * The destination would be the directory the rows are already in, so every
   * one of them would clash with itself and the conflict dialog would ask about
   * the lot.
   */
  it('refuses rows dragged out of itself', () => {
    beginDrag({ connectionId: 'panel', paths: ['/srv/a.txt'] })

    expect(acceptsDrop([SFTP_DRAG], draggedNow()?.connectionId, 'panel')).toBe(false)
  })

  it('takes nothing at all while the panel has no connection', () => {
    expect(acceptsDrop(['Files'], null, null)).toBe(false)
    expect(acceptsDrop([SFTP_DRAG], 'other', undefined)).toBe(false)
  })

  it('ignores a drag carrying something else entirely', () => {
    expect(acceptsDrop(['text/plain'], null, 'panel')).toBe(false)
  })

  /** Files win even when rows from this same panel are what is being dragged. */
  it('takes a drag that carries both files and its own rows', () => {
    beginDrag({ connectionId: 'panel', paths: ['/srv/a.txt'] })

    expect(acceptsDrop(['Files', SFTP_DRAG], 'panel', 'panel')).toBe(true)
  })
})

describe('the drag in progress', () => {
  it('is nothing before one starts', () => {
    expect(draggedNow()).toBeNull()
  })

  it('is remembered while it lasts, because dragover cannot read the payload', () => {
    beginDrag({ connectionId: 'source', paths: ['/a', '/b'] })

    expect(draggedNow()).toEqual({ connectionId: 'source', paths: ['/a', '/b'] })
  })

  it('is forgotten when it ends, so the next dragover is not told about a stale one', () => {
    beginDrag({ connectionId: 'source', paths: ['/a'] })
    endDrag()

    expect(draggedNow()).toBeNull()
  })
})
