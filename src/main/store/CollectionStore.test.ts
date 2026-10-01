import { it, expect, vi } from 'vitest'
import { mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { HostCollection } from '../../shared/types'

let userData = ''
vi.mock('electron', () => ({ app: { getPath: () => userData } }))
userData = mkdtempSync(join(tmpdir(), 'td-collections-'))
const { collectionStore } = await import('./CollectionStore')

it('ignores duplicate and missing reorder ids without losing unmentioned collections', () => {
  for (const id of ['a', 'b', 'c'])
    collectionStore.save({
      id,
      name: id,
      hostIds: [],
      createdAt: 1,
      updatedAt: 1
    } as HostCollection)
  collectionStore.reorder(['b', 'missing', 'b', 'a'])
  expect(collectionStore.list().map((c) => c.id)).toEqual(['b', 'a', 'c'])
  const stored = JSON.parse(readFileSync(join(userData, 'collections.json'), 'utf8'))
  expect(stored.collections.map((c: HostCollection) => c.id)).toEqual(['b', 'a', 'c'])
})
