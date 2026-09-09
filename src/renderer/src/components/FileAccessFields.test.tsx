// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import SessionDialog from './SessionDialog'
import InventoryOverrideDialog from './InventoryOverrideDialog'
import { useStore } from '../state/store'
import type { SessionProfile } from '../../../shared/types'

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
