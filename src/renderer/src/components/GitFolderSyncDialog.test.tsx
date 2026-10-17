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
    {
      path: 'all',
      name: 'all',
      parentPath: null,
      hostCount: 0,
      hostCountWithChildren: 4,
      isNew: false
    },
    {
      path: 'all/prod',
      name: 'prod',
      parentPath: 'all',
      hostCount: 2,
      hostCountWithChildren: 3,
      isNew: false
    },
    {
      path: 'all/prod/web',
      name: 'web',
      parentPath: 'all/prod',
      hostCount: 1,
      hostCountWithChildren: 1,
      isNew: true
    },
    {
      path: 'all/dev',
      name: 'dev',
      parentPath: 'all',
      hostCount: 1,
      hostCountWithChildren: 1,
      isNew: false
    }
  ],
  included: ['all', 'all/prod'],
  removedGroups: [],
  removedHosts: [],
  removedGroupSettings: [],
  revision: 'abc1234',
  files: ['hosts.yml']
}

/** In the order the dialog draws them, which is the order of `preview.groups`. */
function boxes(): HTMLInputElement[] {
  return screen.getAllByRole('checkbox').slice(0, preview.groups.length) as HTMLInputElement[]
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

    expect(applyGitFolder).toHaveBeenCalledWith('folder-1', ['all', 'all/prod', 'all/dev'], {
      showGroupFolders: false,
      includeChildHosts: false
    })
    expect(onClose).toHaveBeenCalled()
  })

  it('applies the folder layout choice and restores it on the next preview', async () => {
    render(
      <GitFolderSyncDialog
        folderName="Infra"
        preview={{ ...preview, showGroupFolders: true }}
        onClose={() => {}}
      />
    )
    const layout = screen.getByRole('checkbox', { name: 'Arrange hosts in group folders' })
    expect((layout as HTMLInputElement).checked).toBe(true)
    await userEvent.click(layout)
    await userEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(applyGitFolder).toHaveBeenCalledWith('folder-1', preview.included, {
      showGroupFolders: false,
      includeChildHosts: false
    })
    await userEvent.click(layout)
    await userEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(applyGitFolder).toHaveBeenLastCalledWith('folder-1', preview.included, {
      showGroupFolders: true,
      includeChildHosts: false
    })
  })

  it('counts and applies the hosts of child groups when that is ticked', async () => {
    render(<GitFolderSyncDialog folderName="Infra" preview={preview} onClose={() => {}} />)
    const counts = (): string[] =>
      [...document.querySelectorAll('.sync-group-list .child-count')].map((c) => c.textContent!)
    expect(counts()).toEqual(['2', '1', '1'])

    await userEvent.click(screen.getByRole('checkbox', { name: 'Include hosts of child groups' }))
    expect(counts()).toEqual(['4', '3', '1', '1'])

    await userEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(applyGitFolder).toHaveBeenCalledWith('folder-1', preview.included, {
      showGroupFolders: false,
      includeChildHosts: true
    })
  })

  it('keeps the dialog open with an error when applying fails', async () => {
    applyGitFolder.mockRejectedValueOnce(new Error('Could not save'))
    const onClose = vi.fn()
    render(<GitFolderSyncDialog folderName="Infra" preview={preview} onClose={onClose} />)
    await userEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(screen.getByRole('alert').textContent).toBe('Could not save')
    expect(onClose).not.toHaveBeenCalled()
    expect((screen.getByRole('button', { name: 'Apply' }) as HTMLButtonElement).disabled).toBe(
      false
    )
  })

  /**
   * The preview says what goes for the choice it opened with. Unticking
   * everything afterwards left it saying nothing would, and Apply then took
   * every host with its local settings and saved passwords.
   */
  it('says what Apply would take for the groups ticked now', async () => {
    const consequences = vi.fn((_id: string, included: string[]) =>
      Promise.resolve({
        removedHosts:
          included.length === 0
            ? [
                { id: 'h1', name: 'web1', hasLocalSettings: true },
                { id: 'h2', name: 'db1', hasLocalSettings: false }
              ]
            : [],
        removedGroupSettings: included.length === 0 ? [{ id: 'g1', name: 'prod' }] : []
      })
    )
    window.td.gitFolder.consequences = consequences
    render(<GitFolderSyncDialog folderName="Infra" preview={preview} onClose={() => {}} />)
    expect(screen.queryByText(/will disappear/)).toBeNull()

    await userEvent.click(screen.getByRole('button', { name: 'Select none' }))

    expect(
      await screen.findByText(/2 hosts will disappear from this folder: web1, db1/)
    ).toBeTruthy()
    expect(screen.getByText(/1 of them have local settings/)).toBeTruthy()
    expect(screen.getByText(/Local settings of groups left out go as well.*: prod/)).toBeTruthy()
    expect(consequences).toHaveBeenLastCalledWith('folder-1', [], { includeChildHosts: false })
    expect(screen.getByRole('button', { name: 'Apply' })).not.toHaveProperty('disabled', true)
  })

  /** A failed check is not a clean one: Apply waits until one succeeds. */
  it('keeps Apply shut when it cannot say what Apply would take', async () => {
    const consequences = vi
      .fn()
      .mockRejectedValueOnce(new Error('the read was forgotten'))
      .mockResolvedValue({
        removedHosts: [{ id: 'h1', name: 'web1', hasLocalSettings: false }],
        removedGroupSettings: []
      })
    window.td.gitFolder.consequences = consequences
    render(<GitFolderSyncDialog folderName="Infra" preview={preview} onClose={() => {}} />)
    const apply = (): HTMLButtonElement =>
      screen.getByRole('button', { name: 'Apply' }) as HTMLButtonElement

    await userEvent.click(screen.getByRole('button', { name: 'Select none' }))
    expect(await screen.findByText(/the read was forgotten/)).toBeTruthy()
    expect(apply().disabled).toBe(true)

    await userEvent.click(screen.getByRole('button', { name: 'Check again' }))
    expect(await screen.findByText(/1 hosts will disappear/)).toBeTruthy()
    expect(apply().disabled).toBe(false)
  })

  it('leaves the folder alone when it is closed instead', async () => {
    const onClose = vi.fn()
    render(<GitFolderSyncDialog folderName="Infra" preview={preview} onClose={onClose} />)

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(applyGitFolder).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })
})
