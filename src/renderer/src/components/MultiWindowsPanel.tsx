import { useEffect, useState } from 'react'
import type { MultiWindow } from '../../../shared/types'
import { useStore, activeTab } from '../state/store'
import { findHost } from '../state/hosts'
import { hostsOf } from '../state/multiWindow'
import { confirmAction } from '../confirm'
import ContextMenu, { type MenuItem } from './ContextMenu'
import MultiWindowDialog from './MultiWindowDialog'
import { SplitRightIcon } from './icons'
import { useT } from '../i18n'
import { SectionHeading, type SectionControls } from './TreeSection'

const INDENT = 8

/**
 * Multi-windows, under the collections: tabs kept by name, panes and all.
 *
 * A collection says which hosts; this says how they stood — split which way
 * and how large — so a desk of four consoles laid out once comes back laid out.
 * A double-click opens one as a new tab in the workspace in front.
 */
export default function MultiWindowsPanel({
  query,
  section
}: {
  query: string
  /** Folding the whole section and moving it — see TreeSection. */
  section?: SectionControls
}): JSX.Element {
  const t = useT()
  const multiWindows = useStore((s) => s.multiWindows)
  const loadMultiWindows = useStore((s) => s.loadMultiWindows)
  const openMultiWindow = useStore((s) => s.openMultiWindow)
  const removeMultiWindow = useStore((s) => s.removeMultiWindow)
  const moveMultiWindow = useStore((s) => s.moveMultiWindow)
  const front = useStore((s) => activeTab(s))
  const state = useStore.getState()
  const [menu, setMenu] = useState<{
    x: number
    y: number
    items: MenuItem[]
    forId: string
  } | null>(null)
  const [dialog, setDialog] = useState<
    { tabId?: string; renaming?: string; defaultName: string } | undefined
  >()

  useEffect(() => {
    void loadMultiWindows()
  }, [loadMultiWindows])

  const needle = query.trim().toLowerCase()
  const visible = needle
    ? multiWindows.filter((w) => w.name.toLowerCase().includes(needle))
    : multiWindows

  function menuFor(w: MultiWindow): MenuItem[] {
    const index = multiWindows.findIndex((x) => x.id === w.id)
    return [
      { label: t('Open'), onSelect: () => openMultiWindow(w.id) },
      {
        label: t('Replace with the tab in front'),
        disabled: !front,
        onSelect: () =>
          front && setDialog({ tabId: front.id, defaultName: w.name, renaming: undefined })
      },
      {
        label: t('Rename…'),
        separated: true,
        onSelect: () => setDialog({ renaming: w.id, defaultName: w.name })
      },
      {
        label: t('Move up'),
        disabled: index <= 0,
        onSelect: () => void moveMultiWindow(w.id, -1)
      },
      {
        label: t('Move down'),
        disabled: index >= multiWindows.length - 1,
        onSelect: () => void moveMultiWindow(w.id, 1)
      },
      {
        label: t('Delete multi-window'),
        danger: true,
        separated: true,
        onSelect: () => {
          if (
            confirmAction(t('Delete the multi-window “{name}”? Its hosts stay.', { name: w.name }))
          )
            void removeMultiWindow(w.id)
        }
      }
    ]
  }

  return (
    <div className="tree-group">
      <SectionHeading section={section} title={t('Multi-windows')}>
        <button
          className="icon-button"
          title={t('Save the tab in front as a multi-window')}
          disabled={!front}
          onClick={() => front && setDialog({ tabId: front.id, defaultName: front.title })}
        >
          +
        </button>
      </SectionHeading>

      {!section?.folded && (
        <>
          {multiWindows.length === 0 && (
            <div
              style={{
                padding: '4px 12px 8px',
                color: 'var(--text-dim)',
                fontSize: 11,
                lineHeight: 1.5
              }}
            >
              {t(
                'A tab kept by name, panes and all. Split a tab into the hosts you want, then press + here or right-click its tab.'
              )}
            </div>
          )}

          {visible.map((w) => {
            const hosts = hostsOf(w.root)
            const missing = hosts.filter((id) => !findHost(state, id)).length
            return (
              <div key={w.id}>
                <div
                  className={`tree-item${menu?.forId === w.id ? ' menu-open' : ''}`}
                  style={{ paddingLeft: INDENT }}
                  title={t('Double-click to open it as a new tab, laid out as it was kept')}
                  onDoubleClick={() => openMultiWindow(w.id)}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    setMenu({ x: e.clientX, y: e.clientY, items: menuFor(w), forId: w.id })
                  }}
                >
                  <span className="name">
                    <span className="session-kind" aria-hidden="true">
                      <SplitRightIcon />
                    </span>
                    {w.name}
                  </span>
                  <div className="actions">
                    <button
                      title={t('Open it as a new tab')}
                      onClick={(e) => {
                        e.stopPropagation()
                        openMultiWindow(w.id)
                      }}
                    >
                      {t('Open')}
                    </button>
                  </div>
                </div>
                <div className="inventory-meta" style={{ paddingLeft: 34 }}>
                  {t('Panes: {count}', { count: hosts.length })}
                  {missing > 0 ? t(' · {count} missing', { count: missing }) : ''}
                </div>
              </div>
            )
          })}
        </>
      )}

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />
      )}
      {dialog && <MultiWindowDialog {...dialog} onClose={() => setDialog(undefined)} />}
    </div>
  )
}
