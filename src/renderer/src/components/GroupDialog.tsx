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
import { inheritedFrom, resolveAuth } from '../../../shared/authResolution'
import AccountSelect from './AccountSelect'
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
import FileAccessFields from './FileAccessFields'
import CollectionFields from './CollectionFields'
import { changedCollections, membershipsOf, type Membership } from '../state/membership'
import { descendsFrom } from '../../../shared/groups'
import PagedDialog, { type DialogPage } from './PagedDialog'
import ColourField from './ColourField'
import { SettingsGroup, SwitchRow } from './SettingsGroup'
import { useT } from '../i18n'
import Hint from './Hint'

/** The pages of the group dialog. */
type GroupPage = 'general' | 'ssh' | 'desktop' | 'appearance' | 'git'

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
  const credentials = useStore((s) => s.credentials)
  const settings = useStore((s) => s.settings)
  const upsertGroup = useStore((s) => s.upsertGroup)
  const sessions = useStore((s) => s.sessions)
  const gitFolderTrees = useStore((s) => s.gitFolderTrees)
  const collections = useStore((s) => s.collections)
  const upsertCollection = useStore((s) => s.upsertCollection)
  /**
   * Repositories already in use. The same inventory regularly holds production
   * in one file and staging in another, so the second folder on it should be a
   * choice from this list and a different path — not the address typed again,
   * subtly differently, into a second clone.
   */
  const gitRepos = useStore((s) => s.gitRepos)
  const t = useT()

  const [group, setGroup] = useState<SessionGroup>(initial ?? { id: nanoid(), name: '', parentId })
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
  /** Typed for the RDP hosts inside, which rarely share the SSH password. */
  const [rdpSecret, setRdpSecret] = useState('')
  const [forgetRdpSecret, setForgetRdpSecret] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState<GroupPage>('general')
  /**
   * Every host in this group as it stands, subgroups and what folders inside
   * mirror from git included — what ticking a collection below puts into it.
   * Taken once, when the dialog opens: a sync finishing meanwhile must not
   * change what the ticks were shown against.
   */
  const [hostIds] = useState<string[]>(() =>
    initial
      ? [
          ...sessions
            .filter((s) => s.groupId && descendsFrom(groups, s.groupId, initial.id))
            .map((s) => s.id),
          ...gitFolderTrees
            .filter((tree) => descendsFrom(groups, tree.groupId, initial.id))
            .flatMap((tree) => tree.sessions.map((s) => s.id))
        ]
      : []
  )
  const [memberOf, setMemberOf] = useState<Record<string, Membership>>(() =>
    membershipsOf(collections, hostIds)
  )

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
  const auth = authFieldsState({
    own: group,
    parentId: group.parentId,
    groups,
    forgetSecret,
    context: { credentials }
  })
  const effective = auth.effective
  const from = (key: keyof AuthDefaults): string => {
    const source = auth.inheritedFrom(key)
    return source ? t('inherited from {name}', { name: source.name }) : ''
  }
  const ownSecret = auth.ownSecret
  /** An account chosen on this group itself replaces the login fields under it. */
  const ownAccount = auth.account?.from === 'self'

  /*
   * The RDP half, as the parent chain hands it down: what a blank field here
   * falls back to. The group's own RDP fields are the ones being edited, so
   * only what lies above them is resolved.
   */
  const standsAlone = group.inheritAuth === false
  const rdpAbove = resolveAuth({}, standsAlone ? null : group.parentId, groups, {
    protocol: 'rdp',
    credentials
  })
  const rdpFrom = (key: 'port' | 'username'): string => {
    if (standsAlone) return ''
    const source = inheritedFrom({}, group.parentId, groups, key, { protocol: 'rdp' })
    return source ? t('inherited from {name}', { name: source.name }) : ''
  }
  const rdpAccountAbove = standsAlone
    ? undefined
    : authFieldsState({
        own: {},
        parentId: group.parentId,
        groups,
        forgetSecret: false,
        context: { protocol: 'rdp', credentials }
      }).account
  const ownRdpSecret = isSet(group.rdpSecretRef)
  const rdpAccount = credentials.find((c) => c.id === group.rdpCredentialId)

  const desktop = resolveRdp(pending, pending.parentId, groups)
  const rdpNote = (key: keyof RdpDefaults): string => {
    const source = rdpInheritedFrom(pending, pending.parentId, groups, key)
    return source ? t('inherited from {name}', { name: source.name }) : ''
  }
  const ownGatewaySecret = isSet(group.gatewaySecretRef)

  const appearance = resolveAppearance(group, group.parentId, groups, settings)
  const inheritedLook = inheritedAppearance(group, group.parentId, groups, settings)
  const appearanceFrom = (key: keyof AppearanceDefaults): string => {
    const source = appearanceSource(group, group.parentId, groups, key)
    return source ? t('the group {name}', { name: source.name }) : t('the settings')
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
      setError(t('Name is required'))
      setPage('general')
      return
    }
    if (
      group.fileAccess?.protocol === 'scp' &&
      (!group.fileAccess.shell?.trim() || /[\r\n\0]/.test(group.fileAccess.shell))
    ) {
      setError(t('Enter a single-line shell launch command.'))
      setPage('ssh')
      return
    }
    if (linked && !link?.repoUrl.trim()) {
      setError(t('A repository address is required'))
      setPage('git')
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

    // Said here when refused, rather than leaving Save doing nothing.
    try {
      await upsertGroup(
        { ...group, git },
        secretToSave(auth.shownMethod, forgetSecret, secret),
        gatewaySecret || (forgetGatewaySecret ? null : undefined),
        rdpSecret || (forgetRdpSecret ? null : undefined)
      )
      for (const collection of changedCollections(collections, hostIds, memberOf)) {
        await upsertCollection(collection)
      }
    } catch (err) {
      setError((err as Error).message)
      return
    }
    onClose()
    if (git && !wasLinked) onLinked?.(group.id)
  }

  const secretHint =
    ownSecret && !forgetSecret
      ? t('(saved on this group)')
      : from('secretRef')
        ? t('(blank keeps the one {source})', { source: from('secretRef') })
        : t('(leave blank to keep or inherit)')

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

  const parentName = groups.find((g) => g.id === group.parentId)?.name
  const pages: DialogPage<GroupPage>[] = [
    { id: 'general', label: t('General'), icon: 'host' },
    /* Two pages for signing in, because a folder holds Linux and Windows
       machines alike and they share neither a port nor, usually, an account.
       Each host takes the one that matches the protocol it is saved with. */
    { id: 'ssh', label: 'SSH', icon: 'login' },
    { id: 'desktop', label: t('Desktop'), icon: 'desktop' },
    { id: 'appearance', label: t('Appearance'), icon: 'appearance' },
    { id: 'git', label: 'Git', icon: 'git', badge: linked ? t('on') : undefined }
  ]

  return (
    <PagedDialog
      title={initial ? group.name || t('Edit group') : t('New group')}
      subtitle={parentName ? t('in {name}', { name: parentName }) : t('(top level)')}
      pages={pages}
      page={page}
      onPage={setPage}
      error={error}
      onClose={onClose}
      actions={
        <>
          <button onClick={onClose}>{t('Cancel')}</button>
          <button className="primary" onClick={submit} disabled={!group.name.trim()}>
            {t('Save')}
          </button>
        </>
      }
    >
      {page === 'general' && (
        <>
          <p className="settings-note">
            {t(
              'Anything left blank is inherited from the parent group. Sessions inside inherit whatever this group ends up with, so a shared login can be set once here.'
            )}
          </p>
          <SettingsGroup>
            <div className="settings-group-form">
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
            </div>
            {group.parentId && (
              <SwitchRow
                label={t('Inherit connection settings from the parent group')}
                checked={group.inheritAuth !== false}
                onChange={(on) => {
                  set('inheritAuth', on ? undefined : false)
                  chooseInheritance(on)
                }}
              />
            )}
          </SettingsGroup>

          {/* Under the parent, as the other place its hosts belong to. */}
          {hostIds.length > 0 && (
            <CollectionFields
              collections={collections}
              value={memberOf}
              onChange={setMemberOf}
              forGroup
            />
          )}

          <SettingsGroup title={t('In the tree')}>
            <ColourField value={group.color} onChange={(colour) => set('color', colour)} />
          </SettingsGroup>
        </>
      )}

      {page === 'ssh' && (
        <>
          <SettingsGroup
            title={t('Who signs in')}
            hint={t(
              'Used by the SSH hosts in this group. Anything left blank is inherited from the parent group.'
            )}
          >
            <div className="settings-group-form">
              <div className="form-row">
                <label style={{ flex: 3 }}>
                  {t('Username')}
                  <input
                    value={group.username ?? ''}
                    disabled={ownAccount}
                    placeholder={
                      auth.account
                        ? t('from the account {name}', { name: auth.account.credential.name })
                        : from('username') || effective.username || t('not set')
                    }
                    onChange={(e) => set('username', e.target.value)}
                  />
                </label>
                <label style={{ flex: 1 }}>
                  {t('Port')}
                  <input
                    type="number"
                    value={group.port ?? ''}
                    placeholder={String(effective.port)}
                    onChange={(e) =>
                      set('port', e.target.value ? Number(e.target.value) : undefined)
                    }
                  />
                </label>
              </div>

              <AccountSelect
                value={group.credentialId}
                onChange={(id) => set('credentialId', id)}
                credentials={credentials}
                inherited={ownAccount ? undefined : auth.account}
              />

              {!ownAccount && (
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
              )}
            </div>
          </SettingsGroup>

          <SettingsGroup title={t('On connect')}>
            <div className="settings-group-form">
              <label>
                <Hint label={t('Commands')}>
                  {t('Run in the shell of every host in this group, one command per line.')}
                </Hint>
                <textarea
                  rows={3}
                  value={group.onConnectCommand ?? ''}
                  placeholder={from('onConnectCommand') || t('e.g. sudo -i')}
                  onChange={(e) => set('onConnectCommand', e.target.value)}
                />
              </label>
            </div>
          </SettingsGroup>

          {/* The file panel's way in, for every SSH host inside: a folder of
              database servers all reached through `sudo -u postgres` says so
              once, here, instead of on each host. */}
          <SettingsGroup title={t('File access')}>
            <div className="settings-group-form">
              <FileAccessFields
                value={group.fileAccess}
                inherited={
                  resolveAuth({}, standsAlone ? null : group.parentId, groups, { credentials })
                    .fileAccess
                }
                canInherit={Boolean(group.parentId) && !standsAlone}
                inheritedFrom={from('fileAccess')}
                onChange={(value) => set('fileAccess', value)}
              />
            </div>
            <SwitchRow
              label={t('SFTP panel follows the terminal’s directory')}
              checked={effective.followTerminalCwd}
              onChange={(on) => set('followTerminalCwd', on)}
            />
          </SettingsGroup>
        </>
      )}

      {page === 'desktop' && (
        <>
          <SettingsGroup
            title={t('Who signs in')}
            hint={t(
              'Used by the RDP hosts in this group. With no login of its own here, an RDP host signs in with the SSH login above, as it always has.'
            )}
          >
            <div className="settings-group-form">
              <div className="form-row">
                <label style={{ flex: 3 }}>
                  {t('Username')}
                  <input
                    value={group.rdpUsername ?? ''}
                    disabled={isSet(group.rdpCredentialId)}
                    placeholder={
                      isSet(group.rdpCredentialId)
                        ? t('from the account {name}', {
                            name: rdpAccount?.name ?? t('(deleted account)')
                          })
                        : rdpAccountAbove
                          ? t('from the account {name}', {
                              name: rdpAccountAbove.credential.name
                            })
                          : rdpFrom('username') ||
                            (effective.username
                              ? t('as for SSH: {user}', { user: effective.username })
                              : t('not set'))
                    }
                    onChange={(e) => set('rdpUsername', e.target.value || undefined)}
                  />
                </label>
                <label style={{ flex: 1 }}>
                  {t('Port')}
                  <input
                    type="number"
                    value={group.rdpPort ?? ''}
                    placeholder={String(rdpAbove.port)}
                    title={rdpFrom('port') || undefined}
                    onChange={(e) =>
                      set('rdpPort', e.target.value ? Number(e.target.value) : undefined)
                    }
                  />
                </label>
              </div>

              <AccountSelect
                value={group.rdpCredentialId}
                onChange={(id) => set('rdpCredentialId', id)}
                credentials={credentials}
                inherited={rdpAccountAbove}
              />

              {!isSet(group.rdpCredentialId) && (
                <>
                  <label>
                    {t('Password')}
                    <input
                      type="password"
                      value={rdpSecret}
                      placeholder={
                        ownRdpSecret && !forgetRdpSecret
                          ? t('(saved on this group)')
                          : t('(leave blank to keep or inherit)')
                      }
                      onChange={(e) => setRdpSecret(e.target.value)}
                    />
                  </label>
                  {ownRdpSecret && (
                    <p className="settings-note action-note">
                      {forgetRdpSecret ? t('Will be forgotten on save') : t('Saved on this group')}
                      <button type="button" onClick={() => setForgetRdpSecret(!forgetRdpSecret)}>
                        {forgetRdpSecret ? t('Keep it') : t('Forget it')}
                      </button>
                    </p>
                  )}
                </>
              )}
            </div>
          </SettingsGroup>

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
        </>
      )}

      {page === 'appearance' && (
        <SettingsGroup
          title={t('Terminals')}
          hint={t(
            'Everything in this group inherits what you set here, so a whole environment can be given its own colours in one place.'
          )}
        >
          <div className="settings-group-form">
            <AppearanceFields
              value={group}
              set={setLook}
              effective={appearance}
              inherited={inheritedLook}
              inheritedFrom={appearanceFrom}
              inheritToggle={
                group.parentId
                  ? { label: t('Inherit appearance from the parent group') }
                  : undefined
              }
            />
          </div>
        </SettingsGroup>
      )}

      {page === 'git' && (
        <SettingsGroup
          title={t('Inventory from git')}
          hint={
            /* Every word about this lives here rather than under the fields.
               It is worth having and worth reading once; left on the page it
               was two paragraphs of grey text between the address and the next
               section. */
            <>
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
            </>
          }
        >
          <SwitchRow
            label={t('Mirror an inventory from a git repository')}
            checked={linked}
            onChange={setLinked}
          />

          {linked && (
            <div className="settings-group-form">
              {gitRepos.length > 0 && (
                <label>
                  {t('Repository')}
                  <select
                    value={
                      gitRepos.some(
                        (r) => r.url === link?.repoUrl && (r.branch ?? '') === (link?.branch ?? '')
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
                      <option
                        key={`${repo.url}\n${repo.branch ?? ''}`}
                        value={`${repo.url}\n${repo.branch ?? ''}`}
                      >
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
            </div>
          )}
          {!linked && initial?.git && (
            <p className="settings-note">
              {t(
                'Saving now unties this folder: the hosts it mirrored disappear, along with the local settings and passwords kept for them. The repository itself is untouched.'
              )}
            </p>
          )}
        </SettingsGroup>
      )}
    </PagedDialog>
  )
}
