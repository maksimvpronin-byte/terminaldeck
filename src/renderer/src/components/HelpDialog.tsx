import ModalBackdrop from './ModalBackdrop'
import { keyHint } from '../state/keys'

interface Row {
  keys?: string
  what: string
}

interface Section {
  title: string
  rows: Row[]
}

const SECTIONS: Section[] = [
  {
    title: 'Collections',
    rows: [
      { what: 'Your own sets of hosts, under the groups in the Sessions tab' },
      { what: 'A named set that outlives the workspace you opened them in' },
      { what: 'Tick hosts in either tab, then press Collect to save them as a set' },
      { what: 'Or right-click a workspace above and choose “Save as collection…”' },
      { what: 'Close the workspace freely — Open brings the whole set back' },
      { what: 'Saving under a name that already exists offers to add to it or replace it' },
      { what: 'Independent of groups: one host can sit in as many collections as you like' },
      { what: 'A collection carries a colour and a terminal theme for the hosts in it' },
      { what: 'A host with settings of its own keeps them; otherwise the set overrules its group' },
      { what: 'Its look applies where you see it: under the set, or opened from it' },
      { what: 'So one host in two sets looks different depending on which you came through' },
      { what: 'Opened from the ordinary tree, no set applies and its groups decide' },
      { what: 'Being in a collection changes no credentials; those still come from the group' },
      { what: 'A host deleted or gone from an inventory is listed as missing, not dropped' }
    ]
  },
  {
    title: 'Workspaces',
    rows: [
      { what: 'The top strip holds workspaces; each has its own row of tabs beneath it' },
      { what: '“+” makes an empty one — double-click a workspace to rename it' },
      { what: 'Right-click a group or a repository to open everything in a new workspace' },
      { what: 'Drag a tab onto a workspace to move it there; its terminal stays connected' },
      { keys: '⌘⇧1 … ⌘⇧9', what: 'Jump to that workspace' },
      { what: 'Closing a workspace closes every terminal in it' },
      { what: 'A dot on a workspace means new output arrived in one of its tabs' }
    ]
  },
  {
    title: 'Tabs and panes',
    rows: [
      { keys: '⌘P', what: 'Go to a host by name, across saved sessions and inventories' },
      { keys: 'Tab', what: 'In that list, mark several hosts to open at once' },
      { keys: '⇧⏎', what: 'Opens the marked hosts tiled in one tab instead of separate tabs' },
      { keys: '⌥⏎', what: 'Opens the marked hosts in a workspace of their own' },
      { keys: '⌘T', what: 'New tab with the same host as the focused pane' },
      { keys: '⌘W', what: 'Close the focused pane, or the tab when it is the last one' },
      { keys: '⌘1 … ⌘9', what: 'Jump to that tab within the current workspace' },
      { keys: '⌘D', what: 'Split the pane to the right' },
      { keys: '⌘⇧D', what: 'Split the pane downwards' },
      { what: 'Drag a host or a whole tab onto a pane to place them side by side' },
      { what: 'The edge you drop nearest decides which half the new pane takes' },
      { what: 'Use ⇱ in a pane toolbar to move it back out into its own tab' },
      { what: 'Drag the divider between panes to resize them' },
      { what: 'A dot on a background tab means new output arrived there' }
    ]
  },
  {
    title: 'Terminal',
    rows: [
      { keys: '⌘F', what: 'Search the scrollback; ⏎ and ⇧⏎ step through matches' },
      { keys: '⌘+ / ⌘− / ⌘0', what: 'Font size up, down, and back to default' },
      { what: 'Zoom moves the global size, or the host’s own if it has one set' },
      { keys: '⌘C / ⌘V', what: 'Copy the selection, and paste' },
      { keys: 'Ctrl+C', what: 'Left alone as SIGINT, so a hung command can still be stopped' },
      { what: 'Selecting text copies it straight away; right-click pastes' },
      { what: 'Both of those are switchable in Settings if you prefer a menu' }
    ]
  },
  {
    title: 'Remote desktops',
    rows: [
      { keys: 'Ctrl+Alt+End', what: 'Ctrl+Alt+Del on the far side; this machine keeps the real one' },
      { keys: 'F11', what: 'Full screen, which is the only way Alt+Tab reaches the far side' },
      { what: 'Hold Escape to leave full screen: while there, it belongs to the session' },
      { what: 'A watched session cannot take Alt+Tab even full screen — Windows draws it' },
      { what: 'Drop files on the desktop, then paste there: dropping only offers them' },
      { what: 'Copy a file over there and a notice offers to save it here' },
      { what: 'The desktop takes the size of the pane, so dragging a split resizes it' },
      { what: 'A watched session is shown scaled; taking control shows it unscaled' }
    ]
  },
  {
    title: 'Appearance',
    rows: [
      { what: 'Settings → Terminal holds the defaults every terminal starts from' },
      { what: 'A group, a repository or one host can override them under Appearance' },
      { what: 'Font, size, theme, cursor and scrollback each inherit or stand on their own' },
      { what: 'Each control names what it would inherit, and from which group' },
      { what: 'Untick "Inherit appearance" to ignore the groups and follow Settings instead' },
      { what: 'Appearance and credentials are opted out of separately' },
      { what: 'A host theme recolours its terminal only — the app keeps the Settings theme' }
    ]
  },
  {
    title: 'Sessions',
    rows: [
      { what: 'Double-click a host to connect; a single click only selects it' },
      { what: 'Right-click for connect, split, duplicate, edit and delete' },
      { what: 'Deleting lives in that menu alone, behind a prompt — no button to misclick' },
      { keys: '⌘ click', what: 'Tick a host as well, to open several at once' },
      { keys: '⇧ click', what: 'Tick everything between the last click and this one' },
      { what: 'A bar appears with Open, for separate tabs, and Tile, for one tab' },
      { what: 'The selection spans both tabs, so saved and inventory hosts mix freely' },
      { what: 'Drag hosts and groups between groups, or onto empty space for the top level' },
      { what: 'Drop a host onto the top or bottom edge of another to sort the list by hand' },
      { what: 'A line shows the gap it will land in; the order is kept between launches' },
      { what: 'A group holds a shared login, key and port — hosts inside inherit them' },
      { what: 'A blank field means inherit; untick "Inherit" on a host to stand alone' },
      { what: '“On connect” types commands into the shell as soon as it opens' },
      { what: 'It inherits too, so a whole group can start with sudo -i' },
      { what: 'Colour a host or group to tell production apart at a glance' },
      { what: 'A green dot marks a host that already has a terminal open' },
      { keys: '⌘L', what: 'Lock the vault; it also locks itself after 15 minutes idle' },
      { what: 'Settings → Backup moves everything to another machine, credentials optional' }
    ]
  },
  {
    title: 'Running commands everywhere',
    rows: [
      { keys: '⌘K', what: 'Snippet palette: ⏎ runs, ⇧⏎ drops it on the prompt unrun' },
      { what: 'Broadcast mirrors your typing into every terminal you tick' },
      { what: 'The palette states where a command will land before you send it' }
    ]
  },
  {
    title: 'Files (SFTP)',
    rows: [
      { what: 'Open the SFTP panel from a pane toolbar' },
      { what: 'The path box takes a typed path; ⏎ goes there, esc puts it back' },
      { what: '~ and .. are resolved by the server, so they behave as in the shell' },
      { what: 'Typing the path of a file opens its folder and selects it' },
      { what: 'Click a breadcrumb to jump, or ↑ to go up a level' },
      { what: 'The ⇉ button in the path bar makes the panel follow the terminal’s cd' },
      { what: 'It works on the live connection, so it takes effect at once, either way' },
      { what: 'Turning it on types one setup line into the shell, hidden from the screen' },
      { what: 'The host or group setting only decides how a new connection starts' },
      { keys: '⌘ / ⇧ click', what: 'Toggle one file, or extend the selection to a range' },
      { what: 'Double-click opens a folder or downloads a file' },
      { what: 'Right-click to download, rename, delete, or make a folder' },
      { what: '"Edit locally" opens a file in your editor and uploads it on every save' },
      { what: 'Pick that editor in Settings → Files; otherwise the system default is used' },
      { what: 'Drag files or folders in from Finder to upload them' },
      { what: 'Anything that would overwrite is listed first, both ways, and asked about' },
      { what: 'Every clash starts on Skip; nothing is remembered between transfers' },
      { what: 'A folder where a file must go is refused rather than replaced' },
      { what: 'Compare in a clash shows the diff before you decide to replace it' },
      { what: 'Right-click a remote file to compare it against any local one' },
      { what: 'Binary files and anything past 2 MB are not diffed, and say so' },
      { what: 'The listing re-reads itself every few seconds, so changes made in the shell show up' }
    ]
  },
  {
    title: 'Inventory from git',
    rows: [
      { what: 'Add a repository holding an Ansible inventory to get its hosts here' },
      { what: 'Cloned read-only through your own git, so your keys and helpers are used' },
      { what: 'Ansible groups, group_vars and host_vars become groups and connection settings' },
      { what: 'A host in several groups is shown under each, marked ×2 — it is one host' },
      { what: 'Its settings come from one of them: the deepest, alphabetically last' },
      { what: 'Credentials set on the repository are inherited by every host in it' },
      { what: 'A source follows one branch — empty means the default, usually main' },
      { what: 'The line under a repository states the branch, revision and what was read' },
      { what: 'Work on another branch will not appear until you name it or merge it' },
      { what: 'Local tweaks to a host survive the next sync' }
    ]
  }
]

export default function HelpDialog({ onClose }: { onClose: () => void }): JSX.Element {
  return (
    <ModalBackdrop onClose={onClose}>
      <div className="modal-card help-card">
        <h2>Shortcuts and features</h2>
        <p className="settings-note">
          On Windows and Linux read ⌘ as Ctrl.
        </p>

        {SECTIONS.map((section) => (
          <div key={section.title}>
            <h3 className="settings-heading">{section.title}</h3>
            <div className="help-rows">
              {section.rows.map((row, i) => (
                <div className="help-row" key={`${section.title}-${i}`}>
                  <span className="help-keys">
                    {row.keys ? <kbd>{keyHint(row.keys)}</kbd> : null}
                  </span>
                  <span className="help-what">{row.what}</span>
                </div>
              ))}
            </div>
          </div>
        ))}

        <div className="modal-actions">
          <button className="primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </ModalBackdrop>
  )
}
