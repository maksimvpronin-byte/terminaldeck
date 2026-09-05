import { useEffect, useRef, useState } from 'react'
import type { VaultStatus } from '../../shared/types'
import { useStore } from './state/store'
import { applyUiPalette } from './state/settings'
import { useT } from './i18n'
import MainLayout from './components/MainLayout'

function CreateVaultScreen({ onCreated }: { onCreated: () => void }): JSX.Element {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const t = useT()

  async function submit(): Promise<void> {
    if (password.length < 8) {
      setError(t('Master password must be at least 8 characters'))
      return
    }
    if (password !== confirm) {
      setError(t('Passwords do not match'))
      return
    }
    try {
      await window.td.vault.create(password)
      onCreated()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return (
    <div className="gate">
      <div className="gate-card">
        <h1>{t('Welcome to TerminalDeck')}</h1>
        <p>
          {t(
            'Create a master password to protect your saved SSH credentials. This password never leaves your machine.'
          )}
        </p>
        <label>
          {t('Master password')}
          <input
            type="password"
            value={password}
            autoFocus
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <label>
          {t('Confirm password')}
          <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </label>
        {error && <span className="error-text">{error}</span>}
        <button className="primary" onClick={submit}>
          {t('Create vault')}
        </button>
      </div>
    </div>
  )
}

function UnlockScreen({ onUnlocked }: { onUnlocked: () => void }): JSX.Element {
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const t = useT()

  async function submit(): Promise<void> {
    try {
      const res = await window.td.vault.unlock(password)
      if (!res.ok) {
        setError(res.error ?? t('Failed to unlock'))
        return
      }
      onUnlocked()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return (
    <div className="gate">
      <div className="gate-card">
        <h1>TerminalDeck</h1>
        <p>{t('Enter your master password to unlock saved sessions.')}</p>
        <label>
          {t('Master password')}
          <input
            type="password"
            value={password}
            autoFocus
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
          />
        </label>
        {error && <span className="error-text">{error}</span>}
        <button className="primary" onClick={submit}>
          {t('Unlock')}
        </button>
      </div>
    </div>
  )
}

export default function App(): JSX.Element {
  const [status, setStatus] = useState<VaultStatus | null>(null)
  const loadStore = useStore((s) => s.loadStore)
  const vaultLocked = useStore((s) => s.vaultLocked)
  const setVaultUnlocked = useStore((s) => s.setVaultUnlocked)

  const settings = useStore((s) => s.settings)

  const refreshStatus = async (): Promise<void> => setStatus(await window.td.vault.status())

  useEffect(() => {
    refreshStatus()
  }, [])

  // Keep the app chrome in step with the chosen terminal theme.
  useEffect(() => {
    applyUiPalette(settings)
  }, [settings])

  useEffect(() => {
    if (status?.unlocked) loadStore()
  }, [status?.unlocked, loadStore])

  if (!status) return <div className="gate" />

  if (!status.exists) return <CreateVaultScreen onCreated={refreshStatus} />
  if (!status.unlocked) return <UnlockScreen onUnlocked={refreshStatus} />

  /*
   * A re-lock covers the workspace with an opaque overlay rather than
   * unmounting it: unmounting would tear down every terminal and disconnect the
   * live SSH sessions.
   *
   * Covering it is not the same as closing it, and for a while that was all the
   * lock did on this side. The overlay stops the mouse, since it sits on top —
   * but two presses of Tab out of the password field walked the focus into the
   * interface behind it, which was still mounted, still listening and still
   * connected. From there a person at the keyboard could switch tabs, open the
   * snippet palette, and type into a terminal they could not see, on a machine
   * they were not signed in to. `inert` is what actually takes the background
   * out of reach: not focusable, not clickable, not read out.
   */
  return (
    <>
      <Inert when={vaultLocked}>
        <MainLayout />
      </Inert>
      {vaultLocked && (
        <div className="lock-overlay">
          <UnlockScreen onUnlocked={setVaultUnlocked} />
        </div>
      )}
    </>
  )
}

/**
 * Puts a subtree beyond reach while a condition holds.
 *
 * Set through a ref rather than as a JSX attribute: `inert` is a property React
 * only learned to pass through in 19, and setting it by hand works on every
 * version and cannot be quietly dropped by a downgrade. The wrapper contributes
 * no layout of its own — `display: contents` — so nothing about the interface
 * moves when it appears.
 *
 * The *attribute*, not the property. They are the same thing in a browser that
 * implements inertness and nothing alike in one that does not: assigning the
 * property there sets a field on the object that no one reads, and the subtree
 * stays as reachable as it was, silently. The attribute is what the standard
 * defines and what can be seen from the outside — including by the test that
 * proves this works at all.
 */
function Inert({ when, children }: { when: boolean; children: JSX.Element }): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const node = ref.current
    if (!node) return
    if (when) node.setAttribute('inert', '')
    else node.removeAttribute('inert')
    // Anything already focused inside stays focused otherwise, and keystrokes
    // go on reaching it: `inert` stops new focus, not focus already held.
    if (when && node.contains(document.activeElement)) {
      ;(document.activeElement as HTMLElement | null)?.blur()
    }
  }, [when])

  return (
    <div ref={ref} style={{ display: 'contents' }}>
      {children}
    </div>
  )
}
