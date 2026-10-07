import type { ReactNode } from 'react'
import ModalBackdrop from './ModalBackdrop'
import PageIcon, { type PageGlyph } from './PageIcon'

export interface DialogPage<Id extends string = string> {
  id: Id
  label: string
  icon: PageGlyph
  /** A word or a count beside the label: where the page's values come from, or how many. */
  badge?: string
}

/**
 * A dialog laid out as Settings is: what it edits named at the top of a list
 * of pages down the side, the page at the right, the buttons under it.
 *
 * The host dialog was a single column of some twenty fields in a 460px card —
 * name, group, collections, protocol, address, port, the inherit tickbox, the
 * account, the login, the method, the agent, the file panel, the log, the jump
 * host, the commands, the colour, the tags, then three folded sections — and a
 * group's was longer. Here each subject has a page, so the dialog shows a few
 * things at a time and the list says what else there is.
 */
export default function PagedDialog<Id extends string>({
  title,
  subtitle,
  pages,
  page,
  onPage,
  error,
  actions,
  onClose,
  children
}: {
  title: ReactNode
  subtitle?: ReactNode
  pages: DialogPage<Id>[]
  page: Id
  onPage: (page: Id) => void
  error?: string | null
  actions: ReactNode
  onClose: () => void
  children: ReactNode
}): JSX.Element {
  const current = pages.find((p) => p.id === page)
  return (
    <ModalBackdrop onClose={onClose}>
      <div className="modal-card settings-card paged-dialog" onClick={(e) => e.stopPropagation()}>
        <nav className="settings-nav">
          <div className="paged-dialog-title">
            <h2>{title}</h2>
            {subtitle && <div className="paged-dialog-subtitle">{subtitle}</div>}
          </div>
          <div className="settings-nav-section">
            {pages.map((p) => (
              <button
                key={p.id}
                className={p.id === page ? 'active' : ''}
                aria-current={p.id === page ? 'page' : undefined}
                onClick={() => onPage(p.id)}
              >
                <PageIcon page={p.icon} />
                {p.label}
                {p.badge && <span className="nav-badge">{p.badge}</span>}
              </button>
            ))}
          </div>
        </nav>

        <div className="settings-page">
          <div className="settings-page-body" key={page}>
            <h2>{current?.label}</h2>
            {children}
          </div>
          <div className="modal-actions settings-actions">
            {error && (
              <span className="error-text paged-dialog-error" role="alert">
                {error}
              </span>
            )}
            {actions}
          </div>
        </div>
      </div>
    </ModalBackdrop>
  )
}
