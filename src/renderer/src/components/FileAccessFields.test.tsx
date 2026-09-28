// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import SessionDialog from './SessionDialog'
import InventoryOverrideDialog from './InventoryOverrideDialog'
import GroupDialog from './GroupDialog'
import { useStore } from '../state/store'
import type { HostCollection, SessionGroup, SessionProfile } from '../../../shared/types'

const host: SessionProfile = {
  id: 'test',
  name: 'Database',
  host: 'db.internal',
  groupId: null,
  username: 'tester',
  authMethod: 'agent',
  tags: [],
  logToFile: false,
  portForwards: [],
  createdAt: 1,
  updatedAt: 1
}

describe('host file access settings', () => {
  it('saves SCP configuration without changing the SSH login', async () => {
    const save = vi.fn().mockResolvedValue(undefined)
    useStore.setState({ upsertSession: save })
    render(<SessionDialog initial={host} onClose={() => {}} />)
    await userEvent.selectOptions(screen.getByLabelText('File transfer method'), 'scp')
    expect(screen.getByLabelText('Shell launch command')).toHaveValue('sudo -n -i -u postgres')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(save.mock.calls[0][0]).toMatchObject({
      username: 'tester',
      fileAccess: { protocol: 'scp', shell: 'sudo -n -i -u postgres' }
    })
  })

  it('refuses an empty shell command', async () => {
    const save = vi.fn()
    useStore.setState({ upsertSession: save })
    render(
      <SessionDialog
        initial={{ ...host, fileAccess: { protocol: 'scp', shell: '' } }}
        onClose={() => {}}
      />
    )
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(screen.getByText('Enter a single-line shell launch command.')).toBeInTheDocument()
    expect(save).not.toHaveBeenCalled()
  })

  it('stores Git hosts as local overrides and supports switching back to SFTP', async () => {
    const save = vi.fn().mockResolvedValue(undefined)
    useStore.setState({
      saveGitFolderOverride: save,
      gitFolderOverrides: [
        { nodeId: host.id, fileAccess: { protocol: 'scp', shell: 'sudo -n -i -u postgres' } }
      ]
    })
    render(<InventoryOverrideDialog node={host} groups={[]} scope="gitFolder" onClose={() => {}} />)
    expect(screen.getByLabelText('File transfer method')).toHaveValue('scp')
    await userEvent.selectOptions(screen.getByLabelText('File transfer method'), 'sftp')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(save.mock.calls[0][0].fileAccess.protocol).toBe('sftp')
  })
})

describe('file access set on a group', () => {
  const folder: SessionGroup = { id: 'g1', name: 'Databases', parentId: null }

  it('saves SCP on the group, for every SSH host inside', async () => {
    const save = vi.fn().mockResolvedValue(undefined)
    useStore.setState({ upsertGroup: save, groups: [folder], sessions: [], collections: [] })
    render(<GroupDialog initial={folder} onClose={() => {}} />)
    await userEvent.selectOptions(screen.getByLabelText('File transfer method'), 'scp')
    await userEvent.clear(screen.getByLabelText('Shell launch command'))
    await userEvent.type(screen.getByLabelText('Shell launch command'), 'sudo -n -i -u root')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(save.mock.calls[0][0]).toMatchObject({
      fileAccess: { protocol: 'scp', shell: 'sudo -n -i -u root' }
    })
  })

  it('lets a host inside inherit it, and hand a setting of its own back', async () => {
    const save = vi.fn().mockResolvedValue(undefined)
    const scpFolder = { ...folder, fileAccess: { protocol: 'scp' as const, shell: 'sudo -u pg' } }
    useStore.setState({ upsertSession: save, groups: [scpFolder], collections: [] })
    render(
      <SessionDialog
        initial={{ ...host, groupId: 'g1', fileAccess: { protocol: 'sftp' } }}
        onClose={() => {}}
      />
    )
    await userEvent.selectOptions(screen.getByLabelText('File transfer method'), '')
    expect(screen.getByLabelText('Shell launch command')).toHaveValue('sudo -u pg')
    expect(screen.getByLabelText('Shell launch command')).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(save.mock.calls[0][0].fileAccess).toBeUndefined()
  })
})

describe('collections chosen in the dialogs', () => {
  const release: HostCollection = {
    id: 'c1',
    name: 'Release',
    hostIds: ['other'],
    createdAt: 1,
    updatedAt: 1
  }

  it('puts a host into a ticked collection when it is saved', async () => {
    const saveCollection = vi.fn().mockResolvedValue(undefined)
    useStore.setState({
      upsertSession: vi.fn().mockResolvedValue(undefined),
      upsertCollection: saveCollection,
      groups: [],
      collections: [release]
    })
    render(<SessionDialog initial={host} onClose={() => {}} />)
    await userEvent.click(screen.getByLabelText('Release'))
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(saveCollection).toHaveBeenCalledWith({ ...release, hostIds: ['other', 'test'] })
  })

  it('takes every host of a group, subgroups included, out of a collection', async () => {
    const saveCollection = vi.fn().mockResolvedValue(undefined)
    const groups: SessionGroup[] = [
      { id: 'g1', name: 'Prod', parentId: null },
      { id: 'g2', name: 'Db', parentId: 'g1' }
    ]
    useStore.setState({
      upsertGroup: vi.fn().mockResolvedValue(undefined),
      upsertCollection: saveCollection,
      groups,
      sessions: [
        { ...host, id: 'a', groupId: 'g1' },
        { ...host, id: 'b', groupId: 'g2' }
      ],
      gitFolderTrees: [],
      collections: [{ ...release, hostIds: ['a', 'other', 'b'] }]
    })
    render(<GroupDialog initial={groups[0]} onClose={() => {}} />)
    expect(screen.getByLabelText('Release')).toBeChecked()
    await userEvent.click(screen.getByLabelText('Release'))
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(saveCollection).toHaveBeenCalledWith({ ...release, hostIds: ['other'] })
  })
})
