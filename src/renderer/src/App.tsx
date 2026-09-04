import { useEffect, useState } from 'react'
import type { VaultStatus } from '../../shared/types'
import { useStore } from './state/store'
import { applyUiPalette } from './state/settings'
import MainLayout from './components/MainLayout'

function CreateVaultScreen({ onCreated }: { onCreated: () => void }): JSX.Element {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)

  async function submit(): Promise<void> {
    if (password.length < 8) {
      setError('Master password must be at least 8 characters')
      return
    }
    if (password !== confirm) {
      setError('Passwords do not match')
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
        <h1>Welcome to TerminalDeck</h1>
        <p>
          Create a master password to protect your saved SSH credentials. This password never leaves
          your machine.
        </p>
        <label>
          Master password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <label>
          Confirm password
          <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </label>
        {error && <span className="error-text">{error}</span>}
        <button className="primary" onClick={submit}>
          Create vault
        </button>
      </div>
    </div>
  )
}

function UnlockScreen({ onUnlocked }: { onUnlocked: () => void }): JSX.Element {
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)

  async function submit(): Promise<void> {
    try {
      const res = await window.td.vault.unlock(password)
      if (!res.ok) {
        setError(res.error ?? 'Failed to unlock')
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
        <p>Enter your master password to unlock saved sessions.</p>
        <label>
          Master password
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
          Unlock
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

  // A re-lock covers the workspace with an opaque overlay rather than unmounting it:
  // unmounting would tear down every terminal and disconnect the live SSH sessions.
  return (
    <>
      <MainLayout />
      {vaultLocked && (
        <div className="lock-overlay">
          <UnlockScreen onUnlocked={setVaultUnlocked} />
        </div>
      )}
    </>
  )
}
