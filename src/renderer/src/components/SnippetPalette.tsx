import { useEffect, useMemo, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { nanoid } from 'nanoid'
import type { Snippet } from '../../../shared/types'
import { useStore, allRoots } from '../state/store'
import { collectBroadcastTargets } from '../state/paneTree'
import ModalBackdrop from './ModalBackdrop'
import { useT } from '../i18n'

function blank(): Snippet {
  const now = Date.now()
  return { id: nanoid(), name: '', command: '', tags: [], createdAt: now, updatedAt: now }
}

export default function SnippetPalette({ onClose }: { onClose: () => void }): JSX.Element {
  const t = useT()
  const snippets = useStore((s) => s.snippets)
  const upsertSnippet = useStore((s) => s.upsertSnippet)
  const removeSnippet = useStore((s) => s.removeSnippet)
  const sendToTerminals = useStore((s) => s.sendToTerminals)
  const broadcast = useStore((s) => s.broadcast)
  const workspaces = useStore((s) => s.workspaces)

  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const [editing, setEditing] = useState<Snippet | null>(null)
  const [tagsInput, setTagsInput] = useState('')

  const targetCount = broadcast
    ? allRoots({ workspaces }).flatMap(collectBroadcastTargets).length
    : 1

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return snippets
    return snippets.filter((s) =>
      [s.name, s.command, ...s.tags].some((f) => f.toLowerCase().includes(needle))
    )
  }, [snippets, query])

  useEffect(() => {
    setCursor(0)
  }, [query])

  function run(snippet: Snippet, execute: boolean): void {
    const sent = sendToTerminals(snippet.command, execute)
    if (sent > 0) onClose()
  }

  function onKeyDown(e: ReactKeyboardEvent): void {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setCursor((c) => Math.min(c + 1, matches.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setCursor((c) => Math.max(c - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const snippet = matches[cursor]
      // Shift+Enter drops it on the prompt instead of running it.
      if (snippet) run(snippet, !e.shiftKey)
    } else if (e.key === 'Escape') {
      onClose()
    }
  }

  async function saveEditing(): Promise<void> {
    if (!editing || !editing.name.trim() || !editing.command.trim()) return
    const tags = tagsInput
      .split(',')
      .map((tag) => tag.trim())
      .filter(Boolean)
    await upsertSnippet({ ...editing, tags, updatedAt: Date.now() })
    setEditing(null)
    setTagsInput('')
  }

  if (editing) {
    return (
      <ModalBackdrop onClose={() => setEditing(null)}>
        <div className="modal-card" onClick={(e) => e.stopPropagation()}>
          <h2>
            {snippets.some((s) => s.id === editing.id) ? t('Edit snippet') : t('New snippet')}
          </h2>
          <label>
            {t('Name')}
            <input
              autoFocus
              value={editing.name}
              onChange={(e) => setEditing({ ...editing, name: e.target.value })}
            />
          </label>
          <label>
            {t('Command')}
            <textarea
              rows={4}
              value={editing.command}
              onChange={(e) => setEditing({ ...editing, command: e.target.value })}
            />
          </label>
          <label>
            {t('Tags (comma separated)')}
            <input value={tagsInput} onChange={(e) => setTagsInput(e.target.value)} />
          </label>
          <div className="modal-actions">
            <button onClick={() => setEditing(null)}>{t('Cancel')}</button>
            <button
              className="primary"
              onClick={saveEditing}
              disabled={!editing.name.trim() || !editing.command.trim()}
            >
              {t('Save')}
            </button>
          </div>
        </div>
      </ModalBackdrop>
    )
  }

  return (
    <ModalBackdrop onClose={onClose}>
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        <input
          autoFocus
          className="palette-input"
          placeholder={t('Search snippets…')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />

        <div className={`palette-target ${broadcast ? 'broadcasting' : ''}`}>
          {broadcast
            ? t('Broadcast is on — terminals it runs in: {count}', { count: targetCount })
            : t('Runs in the focused terminal')}
        </div>

        <div className="palette-list">
          {matches.length === 0 && (
            <div className="palette-empty">
              {snippets.length === 0
                ? t('No snippets yet.')
                : t('Nothing matches “{query}”.', { query })}
            </div>
          )}
          {matches.map((s, i) => (
            <div
              key={s.id}
              className={`palette-row ${i === cursor ? 'active' : ''}`}
              onMouseEnter={() => setCursor(i)}
              onClick={() => run(s, true)}
            >
              <div className="palette-row-main">
                <span className="palette-name">{s.name}</span>
                <span className="palette-command">{s.command}</span>
              </div>
              <div className="palette-row-actions">
                {s.tags.map((tag) => (
                  <span className="palette-tag" key={tag}>
                    {tag}
                  </span>
                ))}
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    setEditing(s)
                    setTagsInput(s.tags.join(', '))
                  }}
                >
                  {t('Edit')}
                </button>
                <button
                  className="danger"
                  onClick={(e) => {
                    e.stopPropagation()
                    removeSnippet(s.id)
                  }}
                >
                  ✕
                </button>
              </div>
            </div>
          ))}
        </div>

        <div className="palette-footer">
          <span>{t('⏎ run · ⇧⏎ paste without running · ↑↓ move · esc close')}</span>
          <button
            onClick={() => {
              setEditing(blank())
              setTagsInput('')
            }}
          >
            + {t('New snippet')}
          </button>
        </div>
      </div>
    </ModalBackdrop>
  )
}
