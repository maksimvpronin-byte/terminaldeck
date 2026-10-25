import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

let userData = ''
vi.mock('electron', () => ({ app: { getPath: (): string => userData } }))

const { lastUploadFolder, rememberUploadFolder } = await import('./uploadFolder')

beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'td-upload-'))
})

describe('the folder uploads start from', () => {
  it('is nothing until an upload has been picked', () => {
    expect(lastUploadFolder()).toBeUndefined()
  })

  it('is the folder holding what was picked last', () => {
    const photos = join(userData, 'photos')
    mkdirSync(photos)
    rememberUploadFolder([join(photos, 'a.jpg'), join(photos, 'b.jpg')])
    expect(lastUploadFolder()).toBe(photos)
  })

  it('is the parent of a picked folder', () => {
    const site = join(userData, 'site')
    mkdirSync(site)
    rememberUploadFolder([site])
    expect(lastUploadFolder()).toBe(userData)
  })

  it('is forgotten once that folder is gone', () => {
    const gone = join(userData, 'gone')
    mkdirSync(gone)
    rememberUploadFolder([join(gone, 'a.txt')])
    rmSync(gone, { recursive: true })
    expect(lastUploadFolder()).toBeUndefined()
  })
})
