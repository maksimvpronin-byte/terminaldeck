import { describe, it, expect } from 'vitest'
import { ConnectCommands } from './connectCommands'

const buf = (s: string): Buffer => Buffer.from(s, 'utf8')
const OSC7 = '\u001b]7;file://box/etc\u001b\\'

describe('ConnectCommands', () => {
  it('hands its lines over once', () => {
    const c = new ConnectCommands(['sudo -i', 'cd /etc'])
    expect(c.typed).toBe(false)
    expect(c.take()).toEqual(['sudo -i', 'cd /etc'])
    expect(c.typed).toBe(true)
    expect(c.take()).toEqual([])
  })

  it('ignores what the host says before the commands are typed', () => {
    const c = new ConnectCommands(['cd /etc'])
    c.note(buf(`cd /etc\r\n${OSC7}$ `))
    expect(c.echoed).toBe(false)
    expect(c.reported).toBe(false)
  })

  it('sees the last command come back, split across reads', () => {
    const c = new ConnectCommands(['sudo -i', 'cd /etc', ''])
    c.take()
    c.note(buf('sudo -i\r\n[root@box ~]# cd /e'))
    expect(c.echoed).toBe(false)
    c.note(buf('tc\r\n[root@box etc]# '))
    expect(c.echoed).toBe(true)
    expect(c.reported).toBe(false)
  })

  it('counts a directory reported only after the last command, in the same read or later', () => {
    const early = new ConnectCommands(['cd /tmp', 'sudo -i'])
    early.take()
    early.note(buf(`cd /tmp\r\n${OSC7}$ sudo -i\r\n# `))
    expect(early.echoed).toBe(true)
    expect(early.reported).toBe(false)

    const same = new ConnectCommands(['cd /etc'])
    same.take()
    same.note(buf(`cd /etc\r\n${OSC7}$ `))
    expect(same.reported).toBe(true)

    const later = new ConnectCommands(['cd /etc'])
    later.take()
    later.note(buf('cd /etc\r\n'))
    later.note(buf(`${OSC7}$ `))
    expect(later.reported).toBe(true)
  })

  it('finds a command with Cyrillic in it, as the bytes arrive', () => {
    const c = new ConnectCommands(['cd ~/отчёты'])
    c.take()
    const echo = buf('cd ~/отчёты\r\n$ ')
    c.note(echo.subarray(0, 8))
    c.note(echo.subarray(8))
    expect(c.echoed).toBe(true)
  })
})
