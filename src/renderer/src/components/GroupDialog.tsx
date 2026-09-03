import { useState } from 'react'
import { nanoid } from 'nanoid'
import type {
  AppearanceDefaults,
  AuthDefaults,
  GitFolderLink,
  RdpDefaults,
  SessionGroup
} from '../../../shared/types'
import { authFieldsState, secretToSave } from '../../../shared/authFields'
import { isSet } from '../../../shared/overrides'
import {
  appearanceSource,
  inheritedAppearance,
  resolveAppearance
} from '../../../shared/appearance'
import { resolveRdp, rdpInheritedFrom } from '../../../shared/rdpResolution'
import { useStore } from '../state/store'
import AppearanceFields from './AppearanceFields'
import AuthFields, { type AuthWords } from './AuthFields'
import RdpFields from './RdpFields'
import ModalBackdrop from './ModalBackdrop'
import { useT } from '../i18n'
import Hint from './Hint'

interface Props {
  /** Existing group to edit, or the parent id for a new one. */
  initial?: SessionGroup
  parentId?: string | null
  onClose: () => void
  /**
   * Called when saving has just tied this folder to a repository. The folder is
   * empty at that moment and syncing is the obvious next step, so the caller
   * offers it rather than leaving a folder that says "never synced".
   */
  onLinked?: (groupId: string) => void
}

export default function GroupDialog({
  initial,
  parentId = null,
  onClose,
  onLinked
}: Props): JSX.Element {
  const groups = useStore((s) => s.groups)
  const settings = useStore((s) => s.settings)
  const upsertGroup = useStore((s) => s.upsertGroup)
  /**
   * Repositories already in use. The same inventory regularly holds production
   * in one file and staging in another, so the second folder on it should be a
   * choice from this list and a different path — not the address typed again,
   * subtly differently, into a second clone.
   */
  const gitRepos = useStore((s) => s.gitRepos)
  const t = useT()

  const [group, setGroup] = useState<SessionGroup>(
    initial ?? { id: nanoid(), name: '', parentId }
  )
  /**
   * The repository this folder mirrors, while it is being edited. Held apart
   * from the group so unticking the box does not throw away what was typed
   * before the dialog is saved.
   */
  const [link, setLink] = useState<GitFolderLink | undefined>(initial?.git)
  const [linked, setLinked] = useState(Boolean(initial?.git))
  const [pathsInput, setPathsInput] = useState((initial?.git?.paths ?? []).join(', '))
  const [secret, setSecret] = useState('')
  const [forgetSecret, setForgetSecret] = useState(false)
  const [gatewaySecret, setGatewaySecret] = useState('')
  const [forgetGatewaySecret, setForgetGatewaySecret] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function set<K extends keyof SessionGroup>(key: K, value: SessionGroup[K]): void {
    setGroup((g) => ({ ...g, [key]: value }))
  }

  function setLook<K extends keyof AppearanceDefaults>(key: K, value: AppearanceDefaults[K]): void {
    setGroup((g) => ({ ...g, [key]: value }))
  }

  function setRdp<K extends keyof RdpDefaults>(key: K, value: RdpDefaults[K]): void {
    setGroup((g) => ({ ...g, [key]: value }))
  }

  /**
   * "Inherit" covers the credential as well: the group's own is dropped in the
   * same move, so it stops shadowing the parent's. The method dropdown does the
   * same from inside AuthFields; this is the tickbox above it.
   */
  function chooseInheritance(inherit: boolean): void {
    if (auth.ownSecret) setForgetSecret(inherit)
  }

  function setAuth<K extends keyof AuthDefaults>(key: K, value: AuthDefaults[K]): void {
    setGroup((g) => ({ ...g, [key]: value }))
  }

  // What this group would use if it defines nothing itself. A pending "forget"
  // counts, so the note can say what the group falls back to.
  const pending: SessionGroup = forgetSecret ? { ...group, secretRef: undefined } : group
  const auth = authFieldsState({ own: group, parentId: group.parentId, groups, forgetSecret })
  const effective = auth.effective
  const from = (key: keyof AuthDefaults): string => {
    const source = auth.inheritedFrom(key)
    return source ? `inherited from ${source.name}` : ''
  }
  const ownSecret = auth.ownSecret

  const desktop = resolveRdp(pending, pending.parentId, groups)
  const rdpNote = (key: keyof RdpDefaults): string => {
    const source = rdpInheritedFrom(pending, pending.parentId, groups, key)
    return source ? `inherited from ${source.name}` : ''
  }
  const ownGatewaySecret = isSet(group.gatewaySecretRef)

  const appearance = resolveAppearance(group, group.parentId, groups, settings)
  const inheritedLook = inheritedAppearance(group, group.parentId, groups, settings)
  const appearanceFrom = (key: keyof AppearanceDefaults): string => {
    const source = appearanceSource(group, group.parentId, groups, key)
    return source ? `the group ${source.name}` : 'Settings'
  }

  async function pickKey(): Promise<void> {
    const path = await window.td.dialogs.pickPrivateKey()
    if (path) set('privateKeyPath', path)
  }

  function setGit<K extends keyof GitFolderLink>(key: K, value: GitFolderLink[K]): void {
    setLink((g) => ({ repoUrl: '', paths: [], includedGroups: [], ...g, [key]: value }))
  }

  async function submit(): Promise<void> {
    if (!group.name.trim()) {
      setError('Name is required')
      return
    }
    if (linked && !link?.repoUrl.trim()) {
      setError('A repository address is required')
      return
    }
    const paths = pathsInput
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean)
    // What was chosen from this repository, and what it held, are carried
    // through untouched: editing the branch is not an answer to which groups to
    // take, and the next sync asks that question anyway.
    const git: GitFolderLink | undefined =
      linked && link ? { ...link, paths, includedGroups: link.includedGroups ?? [] } : undefined
    const wasLinked = Boolean(initial?.git)

    await upsertGroup(
      { ...group, git },
      secretToSave(auth.shownMethod, forgetSecret, secret),
      gatewaySecret || (forgetGatewaySecret ? null : undefined)
    )
    onClose()
    if (git && !wasLinked) onLinked?.(group.id)
  }

  const secretHint =
    ownSecret && !forgetSecret
      ? '(saved on this group)'
      : from('secretRef')
        ? `(blank keeps the one ${from('secretRef')})`
        : '(leave blank to keep or inherit)'

  /** Lets a group hand the credential back to its parent, or drop a wrong one. */
  const authWords: AuthWords = {
    inherit: t('Inherit'),
    secretHint,
    self: t('this group'),
    held: t(
      'Hosts inside use this unless they hold one of their own — a host that does keeps using it.'
    ),
    forget: from('secretRef')
      ? t('On save this group forgets its own, and uses the one {source}.', {
          source: from('secretRef')
        })
      : t('On save this group forgets its own, and uses whatever each host is asked for.'),
    keyPath: from('privateKeyPath') || t('not set')
  }

  // A group cannot become its own descendant.
  const candidateParents = groups.filter((g) => {
    if (g.id === group.id) return false
    let cursor: string | null = g.parentId
    const seen = new Set<string>()
    while (cursor && !seen.has(cursor)) {
      if (cursor === group.id) return false
      seen.add(cursor)
      cursor = groups.find((x) => x.id === cursor)?.parentId ?? null
    }
    return true
  })

  return (
    <ModalBackdrop onClose={onClose}>
      <div className="modal-card">
        <h2>
          {initial ? t('Edit group') : t('New group')}
          <Hint>
            {t(
              'Anything left blank is inherited from the parent group. Sessions inside inherit whatever this group ends up with, so a shared login can be set once here.'
            )}
          </Hint>
        </h2>

        <label>
          {t('Name')}
          <input autoFocus value={group.name} onChange={(e) => set('name', e.target.value)} />
        </label>

        <label>
          {t('Parent group')}
          <select
            value={group.parentId ?? ''}
            onChange={(e) => set('parentId', e.target.value || null)}
          >
            <option value="">{t('(top level)')}</option>
            {candidateParents.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </label>

        {group.parentId && (
          <label className="checkbox-row" style={{ flexDirection: 'row' }}>
            <input
              type="checkbox"
              checked={group.inheritAuth !== false}
              onChange={(e) => {
                set('inheritAuth', e.target.checked ? undefined : false)
                chooseInheritance(e.target.checked)
              }}
            />
            {t('Inherit connection settings from the parent group')}
          </label>
        )}

        <div className="form-row">
          <label style={{ flex: 3 }}>
            {t('Username')}
            <input
              value={group.username ?? ''}
              placeholder={from('username') || effective.username || t('not set')}
              onChange={(e) => set('username', e.target.value)}
            />
          </label>
          <label style={{ flex: 1 }}>
            {t('Port')}
            <input
              type="number"
              value={group.port ?? ''}
              placeholder={String(effective.port)}
              onChange={(e) => set('port', e.target.value ? Number(e.target.value) : undefined)}
            />
          </label>
        </div>

        <AuthFields
          value={group}
          set={setAuth}
          state={auth}
          secret={secret}
          onSecret={setSecret}
          forgetSecret={forgetSecret}
          onForgetSecret={setForgetSecret}
          onPickKey={pickKey}
          words={authWords}
        />

        <label>
          <Hint label={t('On connect')}>
            {t('Run in the shell of every host in this group, one command per line.')}
          </Hint>
          <textarea
            rows={2}
            value={group.onConnectCommand ?? ''}
            placeholder={from('onConnectCommand') || t('e.g. sudo -i')}
            onChange={(e) => set('onConnectCommand', e.target.value)}
          />
        </label>

        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={effective.followTerminalCwd}
            onChange={(e) => set('followTerminalCwd', e.target.checked)}
          />
          {t('SFTP panel follows the terminal’s directory')}
        </label>

        <details className="settings-section" open={linked && !initial}>
          <summary>
            <Hint label={t('Inventory from git')}>
              {/* Every word about this lives here rather than under the fields.
                  It is worth having and worth reading once; left on the page it
                  was two paragraphs of grey text between the address and the
                  next section, which is most of what the dialog showed. */}
              <p>
                {t(
                  'This folder can mirror an Ansible inventory out of a repository. The hosts it brings in are shown alongside anything you put in the folder yourself, and are refreshed only when you ask for it.'
                )}
              </p>
              <p>
                {t(
                  'Cloned read-only through your system git, so your existing SSH keys or credential helper are used and nothing is ever pushed back. A path may be a file or a directory of *.yml files, read one level deep; leave it empty to scan the repository root.'
                )}
              </p>
              <p>
                {t(
                  'Nothing is fetched on its own: use “Sync with git…” on the folder, and choose there which groups to take. What was taken last time is kept on this machine and shown as soon as the window opens.'
                )}
              </p>
              <p>
                {t(
                  'Several folders can read one repository: it is cloned once, and each folder takes its own paths out of it — production from one inventory file, staging from another. A repository is offered in the list here after its first successful sync.'
                )}
              </p>
            </Hint>
          </summary>

          <label className="checkbox-row" style={{ flexDirection: 'row' }}>
            <input
              type="checkbox"
              checked={linked}
              onChange={(e) => setLinked(e.target.checked)}
            />
            {t('Mirror an inventory from a git repository')}
          </label>

          {linked && (
            <>
              {gitRepos.length > 0 && (
                <label>
                  {t('Repository')}
                  <select
                    value={
                      gitRepos.some(
                        (r) =>
                          r.url === link?.repoUrl && (r.branch ?? '') === (link?.branch ?? '')
                      )
                        ? `${link?.repoUrl}\n${link?.branch ?? ''}`
                        : ''
                    }
                    onChange={(e) => {
                      if (!e.target.value) return
                      const [url, branch] = e.target.value.split('\n')
                      setLink((g) => ({
                        includedGroups: [],
                        ...g,
                        repoUrl: url,
                        branch: branch || undefined,
                        // The paths are the folder's own: pointing a second
                        // folder at the same repository is how you take a
                        // different inventory file out of it.
                        paths: g?.paths ?? []
                      }))
                    }}
                  >
                    <option value="">{t('Another repository…')}</option>
                    {gitRepos.map((repo) => (
                      <option key={`${repo.url}\n${repo.branch ?? ''}`} value={`${repo.url}\n${repo.branch ?? ''}`}>
                        {repo.branch ? `${repo.url} · ${repo.branch}` : repo.url}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              <label>
                {t('Repository URL')}
                <input
                  value={link?.repoUrl ?? ''}
                  placeholder="git@github.com:org/infra.git"
                  onChange={(e) => setGit('repoUrl', e.target.value)}
                />
              </label>
              <div className="form-row">
                <label style={{ flex: 1 }}>
                  {t('Branch')}
                  <input
                    value={link?.branch ?? ''}
                    placeholder={t('default branch')}
                    onChange={(e) => setGit('branch', e.target.value || undefined)}
                  />
                </label>
                <label style={{ flex: 2 }}>
                  {t('Inventory paths (comma separated)')}
                  <input
                    value={pathsInput}
                    placeholder="inventories/prod/hosts.yml"
                    onChange={(e) => setPathsInput(e.target.value)}
                  />
                </label>
              </div>
            </>
          )}
          {!linked && initial?.git && (
            <p className="settings-note">
              {t(
                'Saving now unties this folder: the hosts it mirrored disappear, along with the local settings and passwords kept for them. The repository itself is untouched.'
              )}
            </p>
          )}
        </details>

        <details className="settings-section">
          <summary>
            <Hint label={t('Appearance')}>
              {t(
                'Everything in this group inherits what you set here, so a whole environment can be given its own colours in one place.'
              )}
            </Hint>
          </summary>
          <AppearanceFields
            value={group}
            set={setLook}
            effective={appearance}
            inherited={inheritedLook}
            inheritedFrom={appearanceFrom}
            inheritToggle={
              group.parentId ? { label: t('Inherit appearance from the parent group') } : undefined
            }
          />
        </details>

        <details className="settings-section">
          <summary>
            <Hint label={t('Desktop')}>
              {t(
                'Applies to the RDP hosts in this group. A gateway stated here reaches every one of them, which is the point of putting it on a group rather than on each machine.'
              )}
            </Hint>
          </summary>
          <RdpFields
            value={group}
            set={setRdp}
            effective={desktop}
            inheritedFrom={rdpNote}
            inheritToggle={
              group.parentId
                ? { label: t('Inherit desktop settings from the parent group') }
                : undefined
            }
            secret={{
              typed: gatewaySecret,
              onTyped: setGatewaySecret,
              own: ownGatewaySecret,
              forget: forgetGatewaySecret,
              onForget: setForgetGatewaySecret
            }}
          />
        </details>

        {error && <span className="error-text">{error}</span>}

        <div className="modal-actions">
          <button onClick={onClose}>{t('Cancel')}</button>
          <button className="primary" onClick={submit} disabled={!group.name.trim()}>
            {t('Save')}
          </button>
        </div>
      </div>
    </ModalBackdrop>
  )
}
