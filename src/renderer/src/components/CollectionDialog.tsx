import { useState } from 'react'
import { nanoid } from 'nanoid'
import type { AppearanceDefaults, HostCollection } from '../../../shared/types'
import { resolveAppearance } from '../../../shared/appearance'
import { useStore } from '../state/store'
import { SESSION_COLOURS } from '../state/colours'
import AppearanceFields from './AppearanceFields'
import ModalBackdrop from './ModalBackdrop'

interface Props {
  /** An existing collection to rename or recolour. */
  initial?: HostCollection
  /** Hosts to put in a new one, e.g. the current tree selection. */
  hostIds?: string[]
  /** Prefilled name, e.g. the workspace this is being saved from. */
  defaultName?: string
  defaultColor?: string
  onClose: () => void
}

export default function CollectionDialog({
  initial,
  hostIds,
  defaultName,
  defaultColor,
  onClose
}: Props): JSX.Element {
  const collections = useStore((s) => s.collections)
  const settings = useStore((s) => s.settings)
  const upsertCollection = useStore((s) => s.upsertCollection)
  const [name, setName] = useState(initial?.name ?? defaultName ?? '')
  const [color, setColor] = useState<string | undefined>(initial?.color ?? defaultColor)
  const [look, setLook] = useState<AppearanceDefaults>(initial ?? {})

  function setLookField<K extends keyof AppearanceDefaults>(
    key: K,
    value: AppearanceDefaults[K]
  ): void {
    setLook((l) => ({ ...l, [key]: value }))
  }

  // A collection has no groups above it, so anything left on "inherit" falls
  // through to the application-wide settings.
  const appearance = resolveAppearance(look, null, [], settings)

  const count = initial ? initial.hostIds.length : (hostIds?.length ?? 0)

  /**
   * A collection already using this name. Saving used to mint a new id every
   * time, so pressing save twice on the same workspace left two identical
   * entries; now the clash is stated and the choice is the user's.
   */
  const clash = collections.find(
    (c) => c.id !== initial?.id && c.name.trim().toLowerCase() === name.trim().toLowerCase()
  )
  const merging = Boolean(!initial && clash)

  async function submit(): Promise<void> {
    if (!name.trim() || merging) return
    const now = Date.now()
    await upsertCollection(
      initial
        ? { ...initial, ...look, name: name.trim(), color }
        : {
            ...look,
            id: nanoid(),
            name: name.trim(),
            color,
            hostIds: hostIds ?? [],
            createdAt: now,
            updatedAt: now
          }
    )
    onClose()
  }

  /**
   * Folds this save into the collection that already owns the name. Also what
   * Enter does while a clash is showing, so the key never sits dead.
   */
  async function saveInto(mode: 'add' | 'replace'): Promise<void> {
    if (!clash) return
    const incoming = hostIds ?? []
    await upsertCollection({
      ...clash,
      ...look,
      color: color ?? clash.color,
      hostIds: mode === 'add' ? [...new Set([...clash.hostIds, ...incoming])] : incoming
    })
    onClose()
  }

  return (
    <ModalBackdrop onClose={onClose}>
      <div className="modal-card">
        <h2>{initial ? 'Edit collection' : 'New collection'}</h2>
        <p className="settings-note">
          A saved set of hosts, kept apart from the groups they live in — the same host can be in
          several. It survives closing the workspace, so you can reopen the whole set later.
        </p>

        <label>
          Name
          <input
            autoFocus
            value={name}
            placeholder="e.g. Friday release"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && (merging ? saveInto('add') : submit())}
          />
        </label>

        <label>
          Colour
          <div className="colour-row">
            <button
              type="button"
              className={`swatch none ${!color ? 'selected' : ''}`}
              title="No colour"
              onClick={() => setColor(undefined)}
            />
            {SESSION_COLOURS.map((c) => (
              <button
                type="button"
                key={c.value}
                className={`swatch ${color === c.value ? 'selected' : ''}`}
                style={{ background: c.value }}
                title={c.name}
                onClick={() => setColor(c.value)}
              />
            ))}
          </div>
        </label>

        <details className="settings-section">
          <summary>Appearance</summary>
          <p className="settings-note">
            Worn by every host in this set. A host that has settings of its own keeps them; a
            host that does not takes these instead of its group's.
          </p>
          <AppearanceFields
            value={look}
            set={setLookField}
            effective={appearance}
            inherited={settings}
            inheritedFrom={() => 'Settings'}
          />
        </details>

        <p className="settings-note">
          {count === 0
            ? 'Empty for now — add hosts by ticking them in the tree and pressing Collect.'
            : `${count} host${count === 1 ? '' : 's'}.`}
        </p>

        {merging && clash && (
          <p className="settings-note">
            <strong>“{clash.name}” already exists</strong> with {clash.hostIds.length} host
            {clash.hostIds.length === 1 ? '' : 's'}. Saving again would otherwise leave you with
            two of them, so pick what to do — or change the name above to keep both.
          </p>
        )}
        {initial && clash && (
          <p className="settings-note">
            Another collection is already called “{clash.name}”. Two with the same name are
            allowed, but hard to tell apart.
          </p>
        )}

        <div className="modal-actions">
          <button onClick={onClose}>Cancel</button>
          {merging ? (
            <>
              <button onClick={() => saveInto('replace')}>Replace its hosts</button>
              <button className="primary" onClick={() => saveInto('add')}>
                Add to it
              </button>
            </>
          ) : (
            <button className="primary" onClick={submit} disabled={!name.trim()}>
              Save
            </button>
          )}
        </div>
      </div>
    </ModalBackdrop>
  )
}
