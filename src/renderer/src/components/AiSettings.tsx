import { aiMessage } from './aiMessages'
import { useEffect, useState } from 'react'
import { useT } from '../i18n'
import type { AiSettings as Settings } from '../../../shared/ai'

export default function AiSettings(): JSX.Element {
  const t = useT()
  const [settings, setSettings] = useState<Settings | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    window.td.ai
      .settings()
      .then((value) => {
        if (active) setSettings(value)
      })
      .catch(() => {
        if (active) setError('Could not load AI settings')
      })
    return () => {
      active = false
    }
  }, [])
  async function perform(action: 'save' | 'test' | 'clear'): Promise<void> {
    if (!settings) return
    setBusy(true)
    setError('')
    setMessage('')
    try {
      if (action === 'save') {
        setSettings(
          await window.td.ai.save({
            endpoint: settings.endpoint,
            model: settings.model,
            consent: settings.consent,
            apiKey: apiKey || undefined
          })
        )
        setApiKey('')
        setDirty(false)
        setMessage('AI settings saved')
      } else if (action === 'clear') {
        setSettings(await window.td.ai.clear())
        setApiKey('')
        setDirty(false)
        setMessage('AI settings removed')
      } else {
        await window.td.ai.test()
        setMessage('AI connection works')
      }
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="ai-settings">
      <p className="settings-note">
        {t(
          'Connect an OpenAI-compatible Chat Completions API. Each diagnostic command needs your separate approval.'
        )}
      </p>
      {error && (
        <p className="error-text" role="alert">
          {aiMessage(error, t)}
        </p>
      )}
      {settings && (
        <fieldset disabled={busy}>
          <label>
            {t('API base URL')}
            <input
              type="url"
              value={settings.endpoint}
              placeholder="https://api.openai.com/v1"
              onChange={(e) => {
                setSettings({ ...settings, endpoint: e.target.value })
                setDirty(true)
              }}
            />
          </label>
          <p className="settings-note">
            {t(
              'Include the API prefix, usually /v1. Changing the endpoint requires entering a key again.'
            )}
          </p>
          <label>
            {t('Model ID')}
            <input
              value={settings.model}
              placeholder={t('Model name from your provider')}
              onChange={(e) => {
                setSettings({ ...settings, model: e.target.value })
                setDirty(true)
              }}
            />
          </label>
          <label>
            {t('API key')}
            <input
              type="password"
              autoComplete="new-password"
              value={apiKey}
              placeholder={
                settings.keyPresent ? t('Key saved; leave empty to keep it') : t('Enter API key')
              }
              onChange={(e) => {
                setApiKey(e.target.value)
                setDirty(true)
              }}
            />
          </label>
          <p className="settings-note">
            {t(
              'The key is encrypted in the vault. Saving or removing settings stops active analyses.'
            )}
          </p>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={settings.consent}
              onChange={(e) => {
                setSettings({ ...settings, consent: e.target.checked })
                setDirty(true)
              }}
            />
            {t(
              'Allow sending filtered diagnostic output and log excerpts to this provider after I approve a command.'
            )}
          </label>
          <p className="settings-note">
            {t(
              'Logs may contain sensitive data. Filtering is best-effort. SSH passwords, private keys and terminal history are not included. API usage may be billed by your provider.'
            )}
          </p>
          <div className="ai-actions">
            <button
              className="primary"
              disabled={!settings.model.trim() || !settings.endpoint.trim()}
              onClick={() => void perform('save')}
            >
              {t('Save AI settings')}
            </button>
            <button
              disabled={dirty || !settings.keyPresent || !settings.model}
              onClick={() => void perform('test')}
            >
              {t('Test AI connection')}
            </button>
            <button disabled={!settings.keyPresent} onClick={() => void perform('clear')}>
              {t('Remove AI settings')}
            </button>
          </div>
          <p className="settings-note">
            {t(
              'The connection test sends a small request without server data. Save changes before testing.'
            )}
          </p>
        </fieldset>
      )}
      {busy && <p role="status">{t('Working…')}</p>}
      {message && <p role="status">{aiMessage(message, t)}</p>}
    </section>
  )
}
