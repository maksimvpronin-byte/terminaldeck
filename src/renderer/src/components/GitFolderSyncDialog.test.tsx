// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { GitFolderPreview } from '../../../shared/types'
import { useStore } from '../state/store'
import GitFolderSyncDialog from './GitFolderSyncDialog'

/**
 * The dialog a sync stops at, tested for the two things it promises.
 *
 * Ticking a group takes its subgroups — the promise that makes a large
 * inventory answerable at all — and nothing on disk changes until Apply, which
 * is the promise that makes it safe to open. Both are behaviour of the dialog
 * rather than of the arithmetic underneath it, so neither could be reached by
 * the unit tests that cover `pruneTree` and `reconcileSelection`.
 */

const preview: GitFolderPreview = {
  groupId: 'folder-1',
  groups: [
    { path: 'all', name: 'all', parentPath: null, hostCount: 0, isNew: false },
    { path: 'all/prod', name: 'prod', parentPath: 'all', hostCount: 2, isNew: false },
    { path: 'all/prod/web', name: 'web', parentPath: 'all/prod', hostCount: 1, isNew: true },
    { path: 'all/dev', name: 'dev', parentPath: 'all', hostCount: 1, isNew: false }
  ],
  included: ['all', 'all/prod'],
  removedGroups: [],
  removedHosts: [],
  revision: 'abc1234',
  files: ['hosts.yml']
}

/** In the order the dialog draws them, which is the order of `preview.groups`. */
function boxes(): HTMLInputElement[] {
  return screen.getAllByRole('checkbox') as HTMLInputElement[]
}

const applyGitFolder = vi.fn(() => Promise.resolve())

beforeEach(() => {
  applyGitFolder.mockClear()
  useStore.setState({ applyGitFolder })
})

describe('the sync dialog', () => {
  it('opens with the previous choice ticked', () => {
    render(<GitFolderSyncDialog folderName="Infra" preview={preview} onClose={() => {}} />)

    expect(boxes().map((b) => b.checked)).toEqual([true, true, false, false])
  })

  it('takes the subgroups with the group', async () => {
    render(<GitFolderSyncDialog folderName="Infra" preview={preview} onClose={() => {}} />)
    // `all` is ticked; clicking it unticks the whole branch under it.
    await userEvent.click(boxes()[0])

    expect(boxes().map((b) => b.checked)).toEqual([false, false, false, false])

    // And ticking `prod` again brings back only what is under `prod`.
    await userEvent.click(boxes()[1])
    expect(boxes().map((b) => b.checked)).toEqual([false, true, true, false])
  })

  it('changes nothing until Apply, and then says exactly what was ticked', async () => {
    const onClose = vi.fn()
    render(<GitFolderSyncDialog folderName="Infra" preview={preview} onClose={onClose} />)

    await userEvent.click(boxes()[3])
    expect(applyGitFolder).not.toHaveBeenCalled()

    await userEvent.click(screen.getByRole('button', { name: 'Apply' }))

    expect(applyGitFolder).toHaveBeenCalledWith('folder-1', ['all', 'all/prod', 'all/dev'])
    expect(onClose).toHaveBeenCalled()
  })

  it('leaves the folder alone when it is closed instead', async () => {
    const onClose = vi.fn()
    render(<GitFolderSyncDialog folderName="Infra" preview={preview} onClose={onClose} />)

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(applyGitFolder).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })
})
