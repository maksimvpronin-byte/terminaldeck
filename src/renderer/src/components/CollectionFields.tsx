import type { HostCollection } from '../../../shared/types'
import type { Membership } from '../state/membership'
import { useT } from '../i18n'
import Hint from './Hint'

/**
 * The collections a host is in, or every host in a group — ticked here rather
 * than only by selecting hosts in the tree and pressing Collect.
 *
 * A group is not itself a member of anything: ticking a set puts the hosts it
 * holds now into it, and a host added to the group later is not. A set only
 * some of them are in shows a dash, and is left as it is unless clicked.
 */
export default function CollectionFields({
  collections,
  value,
  onChange,
  forGroup = false
}: {
  collections: HostCollection[]
  value: Record<string, Membership>
  onChange: (value: Record<string, Membership>) => void
  forGroup?: boolean
}): JSX.Element {
  const t = useT()
  const ticked = Object.values(value).filter((m) => m !== 'none').length
  return (
    <details className="settings-section" open={ticked > 0}>
      <summary>
        <Hint label={t('Collections')}>
          {forGroup
            ? t(
                'Puts every host now in this group, subgroups included, into the ticked collections — or takes them out. A host added to the group later is not added on its own.'
              )
            : t(
                'The collections this host is in. A host lives in one group but can be in any number of collections; being in one changes nothing about how it connects.'
              )}
        </Hint>
      </summary>
      {collections.length === 0 ? (
        <p className="settings-note">
          {t('No collections yet. Make one with “+” beside Collections in the host tree.')}
        </p>
      ) : (
        <div className="collection-checks">
          {collections.map((c) => {
            const state = value[c.id] ?? 'none'
            return (
              <label key={c.id} className="checkbox-row" style={{ flexDirection: 'row' }}>
                <input
                  type="checkbox"
                  checked={state === 'all'}
                  ref={(el) => {
                    if (el) el.indeterminate = state === 'some'
                  }}
                  title={state === 'some' ? t('Only some of the hosts are in it') : undefined}
                  onChange={(e) =>
                    onChange({ ...value, [c.id]: e.target.checked ? 'all' : 'none' })
                  }
                />
                <span
                  className="session-dot"
                  style={c.color ? { background: c.color } : undefined}
                  aria-hidden="true"
                />
                {c.name}
              </label>
            )
          })}
        </div>
      )}
    </details>
  )
}
