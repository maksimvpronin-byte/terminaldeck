// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import InventoryOverrideDialog from './InventoryOverrideDialog'
import { useStore } from '../state/store'
import type { SessionProfile } from '../../../shared/types'

const host: SessionProfile = {
  id: 'inv:dc1',
  name: 'dc1',
  host: '172.11.130.121',
  groupId: null,
  username: 'zalomkin_own',
  tags: [],
  logToFile: false,
  portForwards: [],
  createdAt: 1,
  updatedAt: 1
}

/**
 * A repository written by people who never heard of this application says
 * nothing about protocols, and every host it describes therefore opens a
 * terminal — which for a Windows machine means an SSH connection that is
 * refused. Saying so by hand is the way out, and it has to survive a sync.
 */
describe('the protocol of a host from a repository', () => {
  it('can be stated locally when the inventory does not', async () => {
    const save = vi.fn().mockResolvedValue(undefined)
    useStore.setState({ saveInventoryOverride: save, inventoryOverrides: [] })

    render(<InventoryOverrideDialog node={host} groups={[]} scope="inventory" onClose={() => {}} />)

    // What the inventory says, which is nothing, so the default stands.
    expect(screen.getByLabelText('Protocol')).toHaveValue('')

    await userEvent.selectOptions(screen.getByLabelText('Protocol'), 'rdp')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(save.mock.calls[0][0]).toMatchObject({ nodeId: host.id, protocol: 'rdp' })
  })

  /** Handing it back means the repository decides again, not that it becomes SSH. */
  it('goes back to the inventory when the choice is cleared', async () => {
    const save = vi.fn().mockResolvedValue(undefined)
    useStore.setState({
      saveInventoryOverride: save,
      inventoryOverrides: [{ nodeId: host.id, protocol: 'rdp', username: 'admin' }]
    })

    render(<InventoryOverrideDialog node={host} groups={[]} scope="inventory" onClose={() => {}} />)

    expect(screen.getByLabelText('Protocol')).toHaveValue('rdp')
    await userEvent.selectOptions(screen.getByLabelText('Protocol'), '')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(save.mock.calls[0][0].protocol).toBeUndefined()
  })
})
