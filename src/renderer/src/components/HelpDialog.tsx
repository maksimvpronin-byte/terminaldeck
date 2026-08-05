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
    title: 'Tabs and panes',
    rows: [
      { keys: '⌘P', what: 'Go to a host by name, across saved sessions and inventories' },
      { keys: 'Tab', what: 'In that list, mark several hosts to open at once' },
      { keys: '⇧⏎', what: 'Opens the marked hosts tiled in one tab instead of separate tabs' },
      { keys: '⌘T', what: 'New tab with the same host as the focused pane' },
      { keys: '⌘W', what: 'Close the focused pane, or the tab when it is the last one' },
      { keys: '⌘1 … ⌘9', what: 'Jump to that tab' },
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
      { keys: '⌘C / ⌘V', what: 'Copy the selection, and paste' },
      { keys: 'Ctrl+C', what: 'Left alone as SIGINT, so a hung command can still be stopped' },
      { what: 'Selecting text copies it straight away; right-click pastes' },
      { what: 'Both of those are switchable in Settings if you prefer a menu' }
    ]
  },
  {
    title: 'Sessions',
    rows: [
      { what: 'Click a host to connect; right-click for connect, split, duplicate, delete' },
      { keys: '⌘ click', what: 'Tick a host instead of connecting, to open several at once' },
      { keys: '⇧ click', what: 'Tick everything between the last click and this one' },
      { what: 'A bar appears with Open, for separate tabs, and Tile, for one tab' },
      { what: 'The selection spans both tabs, so saved and inventory hosts mix freely' },
      { what: 'Drag hosts and groups between groups, or onto empty space for the top level' },
      { what: 'A group holds a shared login, key and port — hosts inside inherit them' },
      { what: 'A blank field means inherit; untick "Inherit" on a host to stand alone' },
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
      { keys: '⌘ / ⇧ click', what: 'Toggle one file, or extend the selection to a range' },
      { what: 'Double-click opens a folder or downloads a file' },
      { what: 'Right-click to download, rename, delete, or make a folder' },
      { what: '"Edit locally" opens a file in your editor and uploads it on every save' },
      { what: 'Pick that editor in Settings → Files; otherwise the system default is used' },
      { what: 'Drag files or folders in from Finder to upload them' },
      { what: 'The listing re-reads itself every few seconds, so changes made in the shell show up' }
    ]
  },
  {
    title: 'Inventory from git',
    rows: [
      { what: 'Add a repository holding an Ansible inventory to get its hosts here' },
      { what: 'Cloned read-only through your own git, so your keys and helpers are used' },
      { what: 'Ansible groups, group_vars and host_vars become groups and connection settings' },
      { what: 'Credentials set on the repository are inherited by every host in it' },
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
