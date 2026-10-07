import { Fragment, useState } from 'react'
import ModalBackdrop from './ModalBackdrop'
import { WhatsNewDialog } from './WhatsNew'
import { recentNotes } from '../whatsNew'
import { useStore } from '../state/store'
import { keyHint } from '../state/keys'
import { useT, type Translate } from '../i18n'

interface Row {
  keys?: string
  what: string
  /**
   * A line or two to type somewhere else — a variable in an inventory, say.
   *
   * Shown under the row exactly as written and deliberately not translated:
   * it is not prose about the product, it is what has to appear in a file, and
   * a translated key name would be a key that does not work. `keys` is the
   * wrong home for these — that column is a keyboard shortcut, 130px wide,
   * drawn as a key cap.
   */
  example?: string
}

/** A run of rows under a small heading of its own, or under none. */
interface Part {
  title?: string
  rows: Row[]
}

interface Section {
  id: string
  title: string
  parts: Part[]
}

/** A heading in the list on the left, over the sections it gathers. */
interface Chapter {
  title: string
  sections: Section[]
}

/*
 * One page per subject rather than one page of everything. The help was a
 * single column of two hundred and fifty rows in a 620px card, in an order
 * nobody chose — collections first, the vault lock and the update check filed
 * under the session tree, and a remote desktop section seventy rows long. It
 * is laid out as Settings is now: subjects down the side, grouped, and the
 * longer subjects cut into parts with headings of their own.
 */
const CHAPTERS: Chapter[] = [
  {
    title: 'Basics',
    sections: [
      {
        id: 'hosts',
        title: 'Hosts and groups',
        parts: [
          {
            title: 'The tree',
            rows: [
              { what: 'The filter matches group names too, and shows a matching group whole' },
              { what: 'The arrows beside Quick connect open or close every folder at once' },
              {
                what: 'Quick connect… opens a host once, SSH or RDP, saving neither it nor its password'
              },
              {
                what: '⇩ beside + Group imports hosts from ~/.ssh/config, ProxyJump links included'
              },
              { what: 'The mark in front of a name says what it opens: a terminal or a desktop' },
              { what: 'It turns green while that machine is open, desktops and terminals alike' },
              { what: 'A host given a colour wears it as its own background and a coloured edge' },
              {
                what: 'The edge stays while the row is selected, so the colour survives the click'
              },
              {
                what: 'An open host’s name is in bold as well, so it stands out on a coloured row'
              },
              { what: 'Colour a host or group to tell production apart at a glance' },
              { what: 'Settings → Tree and tabs takes away the edge, or the bold' }
            ]
          },
          {
            title: 'Opening a host',
            rows: [
              { what: 'Double-click a host to connect; a single click only selects it' },
              { what: 'A click on a host already open brings its pane forward, keyboard and all' },
              {
                what: 'A double-click on a host already open goes to its tab and reconnects it if dropped'
              },
              {
                what: '“Open another tab” in its menu makes a second; Settings → Tree and tabs turns this off'
              },
              {
                what: 'A desktop is never opened twice for one account: Windows keeps one session per user'
              },
              { what: 'A desktop just opened takes the keyboard, as a new terminal does' },
              { what: 'Right-click for connect, split, duplicate, edit and delete' },
              {
                what: 'Deleting lives in that menu alone, behind a prompt — no button to misclick'
              },
              { what: 'Copy user@host in the same menu puts the address on the clipboard' },
              { what: 'Right-click a group for New session here, New subgroup… and Delete group…' },
              { what: 'Deleting a group keeps its hosts: they move up a level' }
            ]
          },
          {
            title: 'Several at once',
            rows: [
              { keys: '⌘ click', what: 'Tick a host as well, to open several at once' },
              { keys: '⇧ click', what: 'Tick everything between the last click and this one' },
              { what: 'A bar appears with Open, for separate tabs, and Tile, for one tab' },
              {
                what: 'Workspace opens them in a new workspace; Collect puts them into a collection'
              },
              { what: 'Saved hosts and inventory hosts can be ticked together, in one selection' }
            ]
          },
          {
            title: 'Sorting by dragging',
            rows: [
              {
                what: 'Drag hosts and groups between groups, or onto empty space for the top level'
              },
              {
                what: 'Drop a host onto the top or bottom edge of another to sort the list by hand'
              },
              {
                what: 'A group sorts the same way: its edges are the gaps, its middle means inside'
              },
              { what: 'A line shows the gap it will land in; the order is kept between launches' }
            ]
          },
          {
            title: 'What a group passes on',
            rows: [
              {
                what: 'A host’s dialog is in pages: General holds all a new host needs, Sign-in the login'
              },
              {
                what: 'Terminal, Files and Tunnels for a shell, Desktop for a desktop — never both'
              },
              {
                what: 'The list marks a page that inherits from the group, and counts the tunnels'
              },
              { what: 'A group holds a shared login, key and port — hosts inside inherit them' },
              { what: 'A blank field means inherit; untick "Inherit" on a host to stand alone' },
              {
                what: 'That includes the login: blank takes the group’s, or your account on this machine'
              },
              { what: '“On connect” types commands into the shell as soon as it opens' },
              { what: 'It inherits too, so a whole group can start with sudo -i' },
              { what: '"Jump host" reaches a machine through another one, as ProxyJump does' },
              { what: 'The hop is made by this app, so nothing runs on the machine in between' },
              {
                what: '"Forward SSH agent" lets the far host ask this one to sign, whatever you logged in with'
              },
              {
                what: 'The key never travels; root on that host can use it while you are there, so pick hosts you trust'
              },
              {
                what: '"Log session output to file" keeps a transcript per connection under the logs folder'
              },
              { what: 'With no password saved, the connection asks for it when it needs it' },
              { what: 'Two-factor codes are asked for the same way, one prompt after another' },
              {
                what: 'A host key is asked about the first time, then checked; a changed one is warned about'
              },
              {
                what: 'Settings → Security lists the trusted keys, and forgets one when a server is rebuilt'
              },
              {
                what: 'Keys can be OpenSSH files or PuTTY .ppk of any version, with no converting'
              },
              {
                what: 'On Windows the SSH agent is Pageant or the OpenSSH Authentication Agent service'
              }
            ]
          }
        ]
      },
      {
        id: 'tabs',
        title: 'Tabs and panes',
        parts: [
          {
            title: 'Finding a host',
            rows: [
              { keys: '⌘P', what: 'Go to a host by name, across saved sessions and inventories' },
              { keys: 'Tab', what: 'In that list, mark several hosts to open at once' },
              {
                keys: '⇧⏎',
                what: 'Opens the marked hosts tiled in one tab instead of separate tabs'
              },
              { keys: '⌥⏎', what: 'Opens the marked hosts in a workspace of their own' }
            ]
          },
          {
            title: 'Tabs',
            rows: [
              {
                keys: '⌘T',
                what: 'New tab with the same host as the focused pane — a terminal, not a desktop'
              },
              { what: 'Right-click a tab for its host’s menu, as in the tree' },
              { what: 'Two tabs of one host in a row are numbered #1, #2 to tell them apart' },
              { keys: '⌘W', what: 'Close the focused pane, or the tab when it is the last one' },
              { keys: '⌘1 … ⌘9', what: 'Jump to that tab within the current workspace' },
              {
                what: 'A click on a tab gives its pane the keyboard, a desktop too; a jump by number does not'
              },
              { what: 'A dot on a background tab means new output arrived there' },
              {
                what: 'The window opens where it was left, at the size it was, maximised if it was'
              },
              {
                what: 'Workspaces, tabs and splits come back at launch, each pane waiting for Connect'
              },
              { what: 'A pane whose connection dropped offers Reconnect' }
            ]
          },
          {
            title: 'Panes',
            rows: [
              { keys: '⌘D', what: 'Split the pane to the right' },
              { keys: '⌘⇧D', what: 'Split the pane downwards; Ctrl+Shift+E off a Mac' },
              { what: 'Drag a host or a whole tab onto a pane to place them side by side' },
              { what: 'The edge you drop nearest decides which half the new pane takes' },
              { what: 'Use ⇱ in a pane toolbar to move it back out into its own tab' },
              { what: 'Drag the divider between panes to resize them' },
              { what: 'Drag the inner edge of the host list or the file panel to widen it' },
              { what: 'Both remember their width in the window they were set in' }
            ]
          }
        ]
      },
      {
        id: 'workspaces',
        title: 'Workspaces',
        parts: [
          {
            rows: [
              { what: 'The top strip holds workspaces; each has its own row of tabs beneath it' },
              { what: '“+” makes an empty one — double-click a workspace to rename it' },
              { what: 'Right-click a group or a repository to open everything in a new workspace' },
              { what: 'Settings can give each group a workspace of its own, named after it' },
              {
                what: 'Drag a tab onto a workspace to move it there; its terminal stays connected'
              },
              { what: 'Drag a tab beside another to change their order' },
              { keys: '⌘⇧1 … ⌘⇧9', what: 'Jump to that workspace' },
              { what: 'Closing a workspace closes every terminal in it' },
              {
                what: 'Its menu can sign out of every Windows session in it before closing the desktops'
              },
              { what: 'A dot on a workspace means new output arrived in one of its tabs' }
            ]
          }
        ]
      },
      {
        id: 'collections',
        title: 'Collections',
        parts: [
          {
            title: 'Making one',
            rows: [
              { what: 'Your own sets of hosts, in the tree under the groups and the inventory' },
              { what: 'A named set that outlives the workspace you opened them in' },
              { what: 'Tick hosts anywhere in the tree, then press Collect to save them as a set' },
              { what: 'Or right-click a workspace above and choose “Save as collection…”' },
              { what: 'Or tick them under Collections in a host’s settings, or a whole group’s' },
              {
                what: 'Hosts and groups from git or an inventory tick them in their Local settings'
              },
              {
                what: 'Or drag a host, the ticked hosts, or a whole folder onto a set — one from git too'
              },
              { what: 'Saving under a name that already exists offers to add to it or replace it' },
              { what: 'Independent of groups: one host can sit in as many collections as you like' }
            ]
          },
          {
            title: 'Opening one',
            rows: [
              { what: 'Close the workspace freely — Open brings the whole set back' },
              { what: 'Its menu opens it tiled in one tab instead' },
              {
                what: 'A host double-clicked under a set opens in that set’s workspace, or a new one'
              },
              { what: 'Any other host stays out of a set’s workspace, in an ordinary one' }
            ]
          },
          {
            title: 'Look and credentials',
            rows: [
              { what: 'A collection carries a colour and a terminal theme for the hosts in it' },
              {
                what: 'A host with settings of its own keeps them; otherwise the set overrules its group'
              },
              { what: 'Its look applies where you see it: under the set, or opened from it' },
              {
                what: 'So one host in two sets looks different depending on which you came through'
              },
              { what: 'Opened from the ordinary tree, no set applies and its groups decide' },
              {
                what: 'Being in a collection changes no credentials; those still come from the group'
              },
              { what: 'A host deleted or gone from an inventory is listed as missing, not dropped' }
            ]
          }
        ]
      },
      {
        id: 'multiwindows',
        title: 'Multi-windows',
        parts: [
          {
            rows: [
              {
                what: 'A tab kept by name with its panes: which hosts, split which way, how large'
              },
              { what: 'Save one with + under Multi-windows, or right-click its tab' },
              { what: 'Double-click it to open it again as a new tab, every pane connecting' },
              {
                what: 'Only references are kept: no passwords, and Quick connect panes are left out'
              },
              { what: 'Right-click to replace it with the tab in front, rename, reorder or delete' }
            ]
          }
        ]
      }
    ]
  },
  {
    title: 'Connections',
    sections: [
      {
        id: 'terminal',
        title: 'Terminal',
        parts: [
          {
            rows: [
              { keys: '⌘F', what: 'Search the scrollback; ⏎ and ⇧⏎ step through matches' },
              { keys: '⌘+ / ⌘− / ⌘0', what: 'Font size up, down, and back to default' },
              { what: 'Zoom moves the global size, or the host’s own if it has one set' },
              { keys: '⌘C / ⌘V', what: 'Copy the selection, and paste' },
              {
                keys: 'Ctrl+anything',
                what: 'Goes to the shell, never to this app: Ctrl+C interrupts, Ctrl+D ends the session, Ctrl+R, Ctrl+K, Ctrl+W and Ctrl+L do what readline says'
              },
              { what: 'Selecting text copies it straight away; right-click pastes' },
              { what: 'Both of those are switchable in Settings if you prefer a menu' },
              { what: 'That menu copies, pastes, selects all, finds and clears the screen' }
            ]
          }
        ]
      },
      {
        id: 'appearance',
        title: 'Appearance',
        parts: [
          {
            rows: [
              { what: 'Settings → Terminal holds the defaults every terminal starts from' },
              { what: 'A group, a repository or one host can override them under Appearance' },
              {
                what: 'Font, size, theme, cursor and scrollback each inherit or stand on their own'
              },
              { what: 'Each control names what it would inherit, and from which group' },
              {
                what: 'Untick "Inherit appearance" to ignore the groups and follow Settings instead'
              },
              { what: 'Appearance and credentials are opted out of separately' },
              {
                what: 'A host theme recolours its terminal only — the app keeps the Settings theme'
              }
            ]
          }
        ]
      },
      {
        id: 'commands',
        title: 'Running commands everywhere',
        parts: [
          {
            rows: [
              { keys: '⌘K', what: 'Snippet palette: ⏎ runs, ⇧⏎ drops it on the prompt unrun' },
              { what: 'Broadcast mirrors your typing into every terminal you tick' },
              { what: '⇉ above the tabs turns it on, and every pane gets a tick of its own' },
              { what: 'A banner says how many terminals hear you, with All and None' },
              { what: 'Tabs that take part are marked ⇉' },
              { what: 'The palette states where a command will land before you send it' },
              {
                what: '+ New snippet saves a command with a name and tags; each row edits or deletes it'
              }
            ]
          }
        ]
      },
      {
        id: 'several',
        title: 'Opening a host several times',
        parts: [
          {
            rows: [
              { what: 'Right-click a host and choose “Connect several times…”' },
              { what: 'Say how many windows, as which account, and where they should land' },
              { what: 'Separate tabs, tiled into one tab, or a workspace of their own' },
              {
                what: 'Each window is a connection of its own, numbered so they can be told apart'
              },
              {
                what: 'Twenty at once is the limit — every one of them is a real login on the far end'
              }
            ]
          }
        ]
      },
      {
        id: 'tunnels',
        title: 'Tunnels and monitoring',
        parts: [
          {
            title: 'Tunnels',
            rows: [
              { what: 'Tunnels in a pane toolbar forwards ports over that connection' },
              { what: 'Local sends a port here to somewhere the host can reach' },
              { what: 'Remote does the opposite: a port on the host arrives here' },
              { what: 'Dynamic is a SOCKS proxy, for a browser to reach a whole network' },
              { what: 'A rule saved on a session starts by itself whenever that session connects' },
              { what: '"Ad-hoc tunnel" runs one for this connection only and is not saved' }
            ]
          },
          {
            title: 'Monitor',
            rows: [
              { what: 'Monitor in the same toolbar shows load, memory, network, uptime and disks' },
              {
                what: 'Settings → Terminal can show it under every SSH session; its button closes one'
              },
              {
                what: 'It asks the host every three seconds and stops after three failures in a row'
              },
              {
                what: 'It stops asking while its tab is in the background, and picks up on return'
              },
              { what: 'Nothing is installed there: it is one command on a channel of its own' }
            ]
          }
        ]
      },
      {
        id: 'files',
        title: 'Files (SFTP)',
        parts: [
          {
            title: 'Moving around',
            rows: [
              { what: 'Open the SFTP panel from a pane toolbar' },
              { what: 'The path box takes a typed path; ⏎ goes there, esc puts it back' },
              { what: '~ and .. are resolved by the server, so they behave as in the shell' },
              { what: 'Typing the path of a file opens its folder and selects it' },
              { what: 'Click a breadcrumb to jump, or ↑ to go up a level' },
              { what: 'Click a column heading to sort by it, and again to reverse the order' },
              { what: 'The box under the path narrows the folder as you type; * and ? work' },
              {
                what: '⏎ in it searches every folder below as well, and shows where each result is'
              },
              { what: 'Right-click a result for Show in its folder' },
              { what: '⊞ in the path bar shows a folder tree beside the listing' },
              { what: 'Columns give size, date, permissions, owner and group, coloured by kind' },
              { what: 'Drag a column’s edge to widen it; widths and the sort order are remembered' }
            ]
          },
          {
            title: 'Following the terminal',
            rows: [
              { what: 'The ⇉ button in the path bar makes the panel follow the terminal’s cd' },
              { what: 'It works on the live connection, so it takes effect at once, either way' },
              { what: 'Turning it on types one setup line into the shell, hidden from the screen' },
              { what: 'The host or group setting only decides how a new connection starts' }
            ]
          },
          {
            title: 'Transfers',
            rows: [
              { keys: '⌘ / ⇧ click', what: 'Toggle one file, or extend the selection to a range' },
              { what: 'Double-click opens a folder, or a file in your editor' },
              { what: 'Right-click to download, rename, delete, or make a folder' },
              { what: 'Drag files or folders in from Finder to upload them' },
              { what: 'The menu uploads a file or a whole folder too, and downloads a folder' },
              { what: 'Drag files onto another host’s SFTP panel to copy them straight across' },
              {
                what: 'Nothing lands on this machine on the way, and the hosts need no route to each other'
              },
              { what: 'Anything that would overwrite is listed first, both ways, and asked about' },
              { what: 'Every clash starts on Skip; nothing is remembered between transfers' },
              { what: 'A folder where a file must go is refused rather than replaced' },
              { what: 'SCP / Shell can be set on a group, for every SSH host inside it' },
              {
                what: 'With it, files are reached as another user, through a command such as sudo -n -i -u postgres'
              },
              {
                what: 'The terminal keeps its own login, and the command must not ask for a password'
              }
            ]
          },
          {
            title: 'Editing and comparing',
            rows: [
              { what: '"Edit locally" opens a file in your editor and uploads it on every save' },
              {
                what: 'Pick that editor in Settings → Files; otherwise a plain text editor is used'
              },
              { what: 'Compare in a clash shows the diff before you decide to replace it' },
              { what: 'Right-click a remote file to compare it against any local one' },
              { what: 'Binary files and anything past 2 MB are not diffed, and say so' }
            ]
          },
          {
            title: 'Staying current',
            rows: [
              {
                what: 'The listing re-reads itself every few seconds, so changes made in the shell show up'
              },
              {
                what: 'In a tab you are not looking at, and in a hidden window, it stops re-reading'
              },
              {
                what: 'Coming back re-reads at once; the connection and any transfer carry on regardless'
              }
            ]
          }
        ]
      },
      {
        id: 'desktops',
        title: 'Remote desktops',
        parts: [
          {
            title: 'Connection',
            rows: [
              {
                what: 'A host’s dialog has a Desktop page: gateway, screen, keyboard, clipboard and disks'
              },
              { what: 'Set the gateway on the group and every RDP host in it goes through it' },
              { what: 'A gateway can leave private addresses alone and reach them directly' },
              {
                what: 'A certificate the machine cannot verify is asked about once, then remembered'
              },
              {
                what: 'Settings → Security lists what was trusted by hand, and forgets it on request'
              },
              {
                what: 'Nothing types the password into the window: the client signs in outside it'
              },
              {
                what: 'With no password saved the pane asks for one; Try again repeats the last attempt'
              },
              { what: 'Another password… signs in with a different one' },
              {
                what: 'Right-click a Windows host and choose “Connect in console mode” for the /admin session'
              }
            ]
          },
          {
            title: 'Size and picture',
            rows: [
              { what: 'The desktop takes the size of the pane, so dragging a split resizes it' },
              { what: 'Fixed resolution pins the far end and scales it into the pane instead' },
              {
                what: 'The size is counted in the screen’s pixels, so a desktop can be sharper than the pane'
              },
              {
                what: 'Past the pixel budget it asks for less than that rather than what was wanted'
              },
              {
                what: 'A Retina desktop is drawn the usual size by asking for fewer, larger pixels'
              },
              { what: 'How much larger is per host; nothing about the far machine is changed' },
              { what: 'Or tell the session the density and it draws itself larger, sharply' },
              {
                what: 'The picture is decoded by a client of its own, so H.264 hosts are drawn as such'
              },
              { what: 'A desktop in a tab you are not looking at stops being sent its picture' },
              { what: 'Returning draws the whole screen again, without reconnecting' }
            ]
          },
          {
            title: 'Keyboard',
            rows: [
              {
                keys: 'Ctrl+Alt+End',
                what: 'Ctrl+Alt+Del on the far side; this machine keeps the real one'
              },
              { keys: 'Alt+Home', what: 'The Windows key on the far side' },
              {
                what: 'A desktop with the focus takes every shortcut this app owns, ⌘W and Ctrl+W included'
              },
              { what: 'So a key aimed at the far machine cannot close a tab on this one instead' },
              {
                what: 'Nothing is held back: F11 and holding Escape are the way out, and neither is a shortcut'
              },
              { what: 'Click outside the desktop and this app has its shortcuts back' },
              {
                keys: '⌘ as Ctrl',
                what: 'Optional, per host: ⌘C and ⌘V then work as they do on Windows'
              },
              {
                what: '⌘Q and ⌘Tab stay with macOS in a window, and go to the session in full screen'
              },
              {
                what: 'Letters are typed in this machine’s layout: switch it here, with fn on a Mac'
              },
              {
                what: 'The far side’s language follows: it starts in this one and Alt+Shift keeps it level'
              },
              {
                what: 'Changed over there by hand, the two can swap round; ⌥⇧ there puts them back'
              },
              {
                what: 'The mark on a desktop’s bar is the language letters go in; click it if Windows disagrees'
              },
              {
                what: 'The same language shows large over the desktop on fn and on coming back to it'
              },
              {
                what: 'On Windows keys go as keys, as in mstsc: Alt+Shift or Ctrl+Shift switches the desktop itself'
              },
              {
                what: 'Shortcuts, arrows and the keypad still go as keys; turn it off per host for games'
              }
            ]
          },
          {
            title: 'Full screen',
            rows: [
              {
                keys: 'F11',
                what: 'Full screen, which is the only way Alt+Tab reaches the far side'
              },
              { what: 'On a Mac ⌘Tab is the Alt+Tab over there in full screen, and ⌥Tab is too' },
              {
                what: 'macOS gets its shortcuts back on leaving; a three-finger swipe still works'
              },
              { what: 'Only ⌘Tab is taken: screenshots, fn and Spotlight stay with macOS' },
              { what: 'Hold Escape to leave full screen: while there, it belongs to the session' },
              {
                what: 'In full screen, a bar at the top: minimise, leave full screen, close the session'
              },
              { what: 'Drag it along the edge, or onto another display to move the window there' },
              { what: 'Unpinned, it hides until the pointer reaches the top edge above it' },
              { what: 'The pane toolbar goes entirely, so the desktop is the size of the display' },
              {
                what: 'There is nothing of this app over the picture — the top edge belongs to the far side'
              }
            ]
          },
          {
            title: 'Clipboard, sound and disks',
            rows: [
              {
                what: 'The clipboard is shared with a desktop — text both ways, as Windows clients do'
              },
              {
                what: 'Turn it off per host or group for a machine you would rather not hand it to'
              },
              {
                what: 'Files go the same way: copy in Finder, paste in the session, directories and all'
              },
              {
                what: 'Nothing is copied first — the far end reads them off this disk as it pastes'
              },
              {
                what: 'Files copied over there come here first; paste once “Files ready to paste” shows'
              },
              { what: 'The far end’s sound plays here, and can be turned off per host or group' },
              {
                what: 'This computer’s disks can be shared with a desktop, per host or group — off by default'
              }
            ]
          }
        ]
      }
    ]
  },
  {
    title: 'Access and data',
    sections: [
      {
        id: 'accounts',
        title: 'Saved accounts',
        parts: [
          {
            rows: [
              { what: 'Settings → Accounts keeps logins that belong to no host in particular' },
              { what: 'Give each one a name, a username, and a password, a key or the agent' },
              { what: 'Leave the password empty to be asked for it every time it is used' },
              { what: 'Right-click a host and choose “Connect as…” to reach it as one of them' },
              {
                what: 'That applies to the new tab alone; the host keeps the login it is saved with'
              },
              {
                what: 'The pane is named after the account, so a window signed in as somebody else says so'
              },
              { what: 'Reconnecting a pane signs in as the same account again' },
              {
                what: 'Only who you are is replaced: the port, jump host and gateway stay the host’s own'
              },
              {
                what: 'A gateway set to use the host’s credentials is offered the chosen account too'
              },
              { what: 'The jump hosts on the way are still reached as they are configured to be' },
              { what: 'Works the same for a desktop and for an inventory host' },
              { what: 'Passwords live in the vault, exactly as a host’s does' },
              {
                what: 'Accounts travel with a backup; their passwords only if credentials are included'
              }
            ]
          }
        ]
      },
      {
        id: 'vault',
        title: 'Vault and lock',
        parts: [
          {
            rows: [
              {
                keys: '⌘L',
                what: 'Lock the vault; it also locks itself after the delay set in Settings → Security'
              },
              {
                what: 'The eye in a master password field shows what was typed, until pressed again'
              },
              {
                what: 'A locked app opens nothing new: no session, no desktop, no remote file listing'
              },
              {
                what: 'Open sessions stay connected behind the lock, and the keyboard cannot reach them'
              }
            ]
          }
        ]
      },
      {
        id: 'backup',
        title: 'Backup and updates',
        parts: [
          {
            rows: [
              {
                what: 'Settings → Backup moves everything to another machine, credentials optional'
              },
              { what: 'Settings → About shows the version and asks for an update on the spot' },
              { what: 'After an update a plate above the window says what came with it' },
              { what: 'What’s new, beside the version, reads the last few releases again' },
              {
                what: 'An update installs now, at the next quit, or later — open connections are named first'
              }
            ]
          }
        ]
      }
    ]
  },
  {
    title: 'Inventories',
    sections: [
      {
        id: 'inventory',
        title: 'Inventory from git',
        parts: [
          {
            title: 'The repository',
            rows: [
              { what: 'Add a repository holding an Ansible inventory to get its hosts here' },
              {
                what: 'The Inventory section sits in the tree under your hosts: + adds a repository, ⟳ syncs them all'
              },
              {
                what: 'Each repository has its own ⟳ to sync it, and its menu removes it after asking'
              },
              { what: 'Cloned read-only through your own git, so your keys and helpers are used' },
              {
                what: 'Ansible groups, group_vars and host_vars become groups and connection settings'
              },
              { what: 'A host in several groups is shown under each, marked ×2 — it is one host' },
              { what: 'Its settings come from one of them: the deepest, alphabetically last' },
              { what: 'Credentials set on the repository are inherited by every host in it' },
              { what: 'A source follows one branch — empty means the default, usually main' },
              { what: 'The line under a repository states the branch, revision and what was read' },
              { what: 'Work on another branch will not appear until you name it or merge it' },
              {
                what: 'Only YAML is read: .yml and .yaml files, a folder one level deep; INI is not'
              },
              { what: 'Local tweaks to a host survive the next sync' }
            ]
          },
          {
            title: 'Desktops from an inventory',
            rows: [
              { what: 'Every host is an SSH host unless the inventory says otherwise' },
              {
                what: 'terminaldeck_protocol: rdp on a host or a group makes those hosts desktops',
                example: `windows:
  vars:
    terminaldeck_protocol: rdp
  hosts:
    dc1:
    dc2:`
              },
              {
                what: 'On a group it covers every host in it, and a host may disagree with its group'
              },
              {
                what: 'A group_vars file beside the inventory says the same thing',
                example: `# group_vars/windows.yml
terminaldeck_protocol: rdp`
              },
              { what: 'Ansible has no word for this, and its connection plugin is not one' },
              {
                what: 'A desktop ignores ansible_port — that is WinRM’s — and takes terminaldeck_port',
                example: `dc1:
  terminaldeck_protocol: rdp
  terminaldeck_port: 33890`
              },
              { what: 'An inventory that says nothing is corrected in the host’s local settings' },
              { what: 'Right-click the host → Local settings…, and set Protocol there' }
            ]
          }
        ]
      },
      {
        id: 'gitfolder',
        title: 'A Sessions folder tied to git',
        parts: [
          {
            title: 'Linking a folder',
            rows: [
              { what: 'Edit any folder of your own in the tree and point it at a repository' },
              { what: 'A repository used once is offered to every folder made afterwards' },
              {
                what: 'Two folders on one repository share a clone and read their own paths from it'
              },
              {
                what: 'Its hosts land in the folder as one list by default, however deeply the inventory nests them'
              },
              { what: 'They sit beside your own sessions, which can stay in the same folder' },
              { what: 'A host named by several Ansible groups appears once — it is one host' },
              {
                what: 'The groups are still read: they are where a host’s settings and group_vars come from'
              }
            ]
          },
          {
            title: 'Syncing',
            rows: [
              {
                what: 'Nothing is fetched on its own — the folder is read from disk when the window opens'
              },
              {
                what: 'Sync with git… in the folder’s menu goes to the repository'
              },
              { what: 'Every sync asks which groups to take; ticking a group takes its subgroups' },
              { what: 'Groups that appeared since last time arrive ticked and marked new' },
              { what: 'A subgroup you untick stays unticked — it is not offered again as new' },
              {
                what: 'Include hosts of child groups: a group brings every host beneath it, children found by name as Ansible does'
              },
              {
                what: 'Arrange hosts in group folders, in the same dialog, nests them by group instead of one list'
              },
              {
                what: 'What has left the repository leaves the folder, and the dialog says what goes'
              },
              {
                what: 'Local settings and passwords kept for a host that goes are deleted with it'
              },
              {
                what: 'Nothing on disk changes until you press Apply; Cancel leaves the folder as it was'
              },
              { what: 'Read-only, like the Inventory section: nothing is ever pushed back' },
              {
                what: 'A backup carries the repository and the chosen groups, not the mirrored hosts'
              }
            ]
          }
        ]
      }
    ]
  }
]

/** The page every shortcut gathers on, from wherever it is described. */
const SHORTCUTS = 'shortcuts'

const SECTIONS = CHAPTERS.flatMap((chapter) => chapter.sections)

/** Every row that names a key, under the title of the section it comes from. */
function shortcutParts(): Part[] {
  return SECTIONS.map((section) => ({
    title: section.title,
    rows: section.parts.flatMap((part) => part.rows).filter((row) => row.keys)
  })).filter((part) => part.rows.length > 0)
}

/**
 * The rows that mention what was typed, in the language they are read in —
 * a Russian reader searches in Russian — or in the keys they name.
 */
function searchParts(query: string, t: Translate): Part[] {
  const needle = query.trim().toLowerCase()
  return SECTIONS.map((section) => ({
    title: section.title,
    rows: section.parts
      .flatMap((part) => part.rows)
      .filter(
        (row) =>
          t(row.what).toLowerCase().includes(needle) ||
          (row.keys !== undefined && keyHint(row.keys).toLowerCase().includes(needle))
      )
  })).filter((part) => part.rows.length > 0)
}

function HelpRows({ rows }: { rows: Row[] }): JSX.Element {
  const t = useT()
  return (
    <div className={`help-rows${rows.some((row) => row.keys) ? ' has-keys' : ''}`}>
      {rows.map((row, i) => (
        <div className="help-row" key={i}>
          <span className="help-keys">{row.keys ? <kbd>{keyHint(row.keys)}</kbd> : null}</span>
          <span className="help-what">
            {t(row.what)}
            {row.example ? <code className="help-example">{row.example}</code> : null}
          </span>
        </div>
      ))}
    </div>
  )
}

export default function HelpDialog({ onClose }: { onClose: () => void }): JSX.Element {
  // The rows are written in English and translated as they are drawn, so the
  // list above stays one readable table rather than a wall of lookup keys.
  const t = useT()
  const language = useStore((s) => s.settings.language)
  const [notesOpen, setNotesOpen] = useState(false)
  const [page, setPage] = useState(SHORTCUTS)
  const [query, setQuery] = useState('')

  if (notesOpen) {
    return (
      <WhatsNewDialog
        releases={recentNotes(language, window.td.appVersion)}
        onClose={() => setNotesOpen(false)}
      />
    )
  }

  const searching = query.trim() !== ''
  const section = SECTIONS.find((s) => s.id === page)
  const title = searching
    ? t('Search results')
    : section
      ? t(section.title)
      : t('Keyboard shortcuts')
  const parts = searching ? searchParts(query, t) : section ? section.parts : shortcutParts()

  function open(id: string): void {
    setPage(id)
    setQuery('')
  }

  return (
    <ModalBackdrop onClose={onClose}>
      <div className="modal-card settings-card help-card" onClick={(e) => e.stopPropagation()}>
        <nav className="settings-nav" aria-label={t('Shortcuts and features')}>
          <h2>{t('Shortcuts and features')}</h2>
          <input
            className="help-search"
            type="search"
            autoFocus
            value={query}
            placeholder={t('Search the help')}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="settings-nav-section">
            <button
              className={!searching && page === SHORTCUTS ? 'active' : ''}
              aria-current={!searching && page === SHORTCUTS ? 'page' : undefined}
              onClick={() => open(SHORTCUTS)}
            >
              {t('Keyboard shortcuts')}
            </button>
          </div>
          {CHAPTERS.map((chapter) => (
            <div className="settings-nav-section" key={chapter.title}>
              <div className="settings-nav-title">{t(chapter.title)}</div>
              {chapter.sections.map((s) => (
                <button
                  key={s.id}
                  className={!searching && page === s.id ? 'active' : ''}
                  aria-current={!searching && page === s.id ? 'page' : undefined}
                  onClick={() => open(s.id)}
                >
                  {t(s.title)}
                </button>
              ))}
            </div>
          ))}
          {/* Which build this is, where somebody reporting a problem will look
              for it. Read once as the bridge is built, so it is a value here
              rather than something to wait for. */}
          <div className="help-nav-footer">
            <span className="help-version">{window.td.appVersion}</span>
            <button className="help-whats-new" onClick={() => setNotesOpen(true)}>
              {t('What’s new')}
            </button>
          </div>
        </nav>

        <div className="settings-page">
          <div className="settings-page-body" key={searching ? 'search' : page}>
            <h2>{title}</h2>
            {(searching || page === SHORTCUTS) && (
              <p className="settings-note">
                {t('On Windows and Linux read ⌘ as Ctrl+Shift — plain Ctrl belongs to the shell.')}
              </p>
            )}
            {searching && parts.length === 0 && (
              <p className="settings-note">{t('Nothing found.')}</p>
            )}
            {parts.map((part, i) => (
              <Fragment key={`${part.title ?? ''}-${i}`}>
                {part.title && <h3 className="help-part-title">{t(part.title)}</h3>}
                <HelpRows rows={part.rows} />
              </Fragment>
            ))}
          </div>

          <div className="modal-actions settings-actions">
            <button className="primary" onClick={onClose}>
              {t('Done')}
            </button>
          </div>
        </div>
      </div>
    </ModalBackdrop>
  )
}
