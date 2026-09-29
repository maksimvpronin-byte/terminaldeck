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

/**
 * A save the main process refused rejected into nothing: the dialog stayed
 * open, Save did nothing, and nobody was told why.
 */
describe('a save that is refused', () => {
  it('says why, and stays open to try again', async () => {
    const save = vi.fn().mockRejectedValue(new Error('ENOSPC: no space left on device'))
    const onClose = vi.fn()
    useStore.setState({ saveInventoryOverride: save, inventoryOverrides: [] })

    render(<InventoryOverrideDialog node={host} groups={[]} scope="inventory" onClose={onClose} />)
    await userEvent.selectOptions(screen.getByLabelText('Protocol'), 'rdp')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByText(/no space left on device/)).toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
  })
})

/**
 * A host or group from a repository can be put into a collection from its own
 * Local settings, as a saved host or group can from its dialog — not only by
 * ticking it in the tree and pressing Collect.
 */
describe('collections in Local settings', () => {
  const release = { id: 'rel', name: 'Release', hostIds: [], createdAt: 0, updatedAt: 0 }

  it('puts a host from a repository into a ticked collection', async () => {
    const upsertCollection = vi.fn().mockResolvedValue(undefined)
    useStore.setState({
      collections: [release],
      upsertCollection,
      gitFolderOverrides: [],
      gitFolderTrees: []
    })

    render(<InventoryOverrideDialog node={host} groups={[]} scope="gitFolder" onClose={() => {}} />)
    await userEvent.click(screen.getByRole('checkbox', { name: 'Release' }))
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(upsertCollection).toHaveBeenCalledWith({ ...release, hostIds: [host.id] })
  })

  it('puts every host of a repository group into it', async () => {
    const upsertCollection = vi.fn().mockResolvedValue(undefined)
    const group = { id: 'git:f:g:all/web', name: 'web', parentId: 'f' }
    const inWeb = { ...host, id: 'git:f:h:w1', groupId: group.id }
    const elsewhere = { ...host, id: 'git:f:h:d1', groupId: 'git:f:g:all/dev' }
    useStore.setState({
      collections: [release],
      upsertCollection,
      gitFolderOverrides: [],
      gitFolderTrees: [
        {
          groupId: 'f',
          groups: [group, { id: 'git:f:g:all/dev', name: 'dev', parentId: 'f' }],
          sessions: [inWeb, elsewhere],
          memberships: { [inWeb.id]: [group.id], [elsewhere.id]: ['git:f:g:all/dev'] }
        }
      ]
    })

    render(
      <InventoryOverrideDialog node={group} groups={[group]} scope="gitFolder" onClose={() => {}} />
    )
    await userEvent.click(screen.getByRole('checkbox', { name: 'Release' }))
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(upsertCollection).toHaveBeenCalledWith({ ...release, hostIds: [inWeb.id] })
  })
})
