import { describe, it, expect } from 'vitest'
import { spawnSync } from 'child_process'
import { existsSync } from 'fs'
import { MAX_OSC7, OSC7_SHELL_SETUP, scanOsc7 } from './osc7'

const ESC = '\u001b'
const BEL = '\u0007'
/** A complete OSC 7 sequence, BEL-terminated unless told otherwise. */
const seq = (url: string, terminator = BEL): string => `${ESC}]7;${url}${terminator}`

describe('scanOsc7', () => {
  it('finds nothing in ordinary output', () => {
    expect(scanOsc7('total 4\ndrwxr-xr-x 2 max max\n')).toEqual({ path: undefined, rest: '' })
  })

  it('reads a path terminated by BEL', () => {
    expect(scanOsc7(seq('file://box/var/log')).path).toBe('/var/log')
  })

  it('reads a path terminated by ESC backslash', () => {
    expect(scanOsc7(seq('file://box/var/log', `${ESC}\\`)).path).toBe('/var/log')
  })

  it('ignores whatever hostname the shell claims', () => {
    expect(scanOsc7(seq('file://anything-at-all/srv')).path).toBe('/srv')
  })

  it('decodes percent escapes, so a path with a space arrives whole', () => {
    expect(scanOsc7(seq('file://box/home/max/my%20files')).path).toBe('/home/max/my files')
  })

  it('survives a stray percent that is not an escape', () => {
    expect(scanOsc7(seq('file://box/tmp/100%done')).path).toBe('/tmp/100%done')
  })

  it('takes the last path when several arrive at once', () => {
    const chunk = `${seq('file://box/first')}some output${seq('file://box/second')}`
    expect(scanOsc7(chunk).path).toBe('/second')
  })

  it('keeps an unfinished sequence for the next chunk', () => {
    const first = scanOsc7(`output${ESC}]7;file://box/var`)
    expect(first.path).toBeUndefined()
    expect(first.rest).toBe(`${ESC}]7;file://box/var`)
    // The caller prepends the tail before scanning the next chunk.
    expect(scanOsc7(`${first.rest}/log${BEL}`).path).toBe('/var/log')
  })

  it('reports a completed path even when another sequence is still arriving', () => {
    const scan = scanOsc7(`${seq('file://box/done')}${ESC}]7;file://box/partial`)
    expect(scan.path).toBe('/done')
    expect(scan.rest).toBe(`${ESC}]7;file://box/partial`)
  })

  it('keeps a start marker split mid-way across two reads', () => {
    // The chunk ends on a bare ESC; dropping it would lose the next sequence.
    expect(scanOsc7(`output${ESC}`).rest).toBe(ESC)
    expect(scanOsc7(`output${ESC}]`).rest).toBe(`${ESC}]`)
    expect(scanOsc7(`output${ESC}]7`).rest).toBe(`${ESC}]7`)
  })

  it('does not hoard output when no sequence is pending', () => {
    // Otherwise a chatty command would grow the buffer without bound.
    expect(scanOsc7('x'.repeat(10_000)).rest).toBe('')
  })

  it('ignores a malformed url without a path', () => {
    expect(scanOsc7(seq('file://box')).path).toBeUndefined()
    expect(scanOsc7(seq('http://box/var')).path).toBeUndefined()
  })

  /**
   * A start that never ended kept everything after it: each read was appended
   * and scanned again, and the buffer grew with the session.
   */
  it('gives up on a sequence that runs longer than any real one', () => {
    let pending = ''
    pending = scanOsc7(pending + `${ESC}]7;file://box/`).rest
    for (let i = 0; i < 1000; i++) {
      pending = scanOsc7(pending + 'x'.repeat(8192)).rest
      expect(pending.length).toBeLessThanOrEqual(MAX_OSC7)
    }
    expect(pending).toBe('')
  })

  it('still finds a real sequence after one it gave up on', () => {
    const junk = `${ESC}]7;${'x'.repeat(MAX_OSC7 + 1)}`
    expect(scanOsc7(`${junk}${seq('file://box/home')}`).path).toBe('/home')

    // And across reads: nothing of the abandoned one is carried into the next.
    const pending = scanOsc7(junk).rest
    expect(pending).toBe('')
    expect(scanOsc7(pending + `more${seq('file://box/srv')}`).path).toBe('/srv')
  })

  it('waits for a long real path', () => {
    const long = '/d'.repeat(2000)
    const first = scanOsc7(`${ESC}]7;file://box${long}`)
    expect(first.rest.length).toBeGreaterThan(4000)
    expect(scanOsc7(`${first.rest}${BEL}`).path).toBe(long)
  })
})

describe('OSC7_SHELL_SETUP', () => {
  it('starts with a space, so a shell told to skip such lines does not file it', () => {
    expect(OSC7_SHELL_SETUP.startsWith(' ')).toBe(true)
  })

  it('has no ! for an interactive zsh to expand', () => {
    expect(OSC7_SHELL_SETUP).not.toContain('!')
  })

  it('is one line', () => {
    expect(OSC7_SHELL_SETUP).not.toMatch(/[\r\n]/)
  })

  /**
   * Types the line into a real interactive bash between two commands of the
   * user's, and returns what `history` lists afterwards, one command a line.
   */
  const historyAround = (env: Record<string, string>, before = 'echo before'): string[] => {
    const input = `${before}\n${OSC7_SHELL_SETUP}\necho after\nhistory\n`
    const run = spawnSync('/bin/bash', ['--norc', '--noprofile', '-i'], {
      input,
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', HOME: '/nonexistent', HISTFILE: '/dev/null', ...env }
    })
    // Each prompt is preceded by the line's own OSC 7, with no newline after it.
    return (
      run.stdout
        // eslint-disable-next-line no-control-regex
        .replace(/\u001b\][^\u0007\u001b]*(\u0007|\u001b\\)/g, '')
        .split('\n')
        .filter((line) => /^ +\d+ {2}/.test(line))
        .map((line) => line.replace(/^ +\d+ {2}/, ''))
    )
  }

  describe.skipIf(!existsSync('/bin/bash'))('in bash', () => {
    it.each(['', 'ignoredups', 'ignorespace', 'ignoreboth'])(
      'takes itself out of the history with HISTCONTROL=%j',
      (histcontrol) => {
        expect(historyAround({ HISTCONTROL: histcontrol })).toEqual([
          'echo before',
          'echo after',
          'history'
        ])
      }
    )

    it("leaves the user's newest command alone when history is off", () => {
      expect(historyAround({ HISTCONTROL: '' }, 'set +o history')).toEqual(['set +o history'])
    })

    it('takes out a copy the host files only at the prompt after it ran', () => {
      // A host hook that files the line once it has run, its leading space
      // gone, from a PROMPT_COMMAND that ends in a semicolon. The hook's own
      // line spells the name in two halves, so it is not mistaken for the copy.
      const hook =
        't=$(mktemp); echo "__td""7(){ copy" >"$t"; c=0; ' +
        'f(){ c=$((c+1)); if [ $c = 2 ]; then history -r "$t"; rm -f "$t"; fi; }; PROMPT_COMMAND="f;"'
      expect(historyAround({ HISTCONTROL: '' }, hook)).toEqual([hook, 'echo after', 'history'])
    })

    it('looks the second time only once, and keeps the prompt setup it found', () => {
      const run = spawnSync('/bin/bash', ['--norc', '--noprofile', '-i'], {
        input: `PROMPT_COMMAND='echo mine'\n${OSC7_SHELL_SETUP}\necho "[$PROMPT_COMMAND]"\n`,
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '', HOME: '/nonexistent', HISTFILE: '/dev/null' }
      })
      expect(run.stdout).toContain('[__td7;echo mine]')
    })

    it('still reports the directory', () => {
      const run = spawnSync('/bin/bash', ['--norc', '--noprofile', '-i'], {
        input: `${OSC7_SHELL_SETUP}\ncd /\n`,
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '', HOME: '/nonexistent', HISTFILE: '/dev/null' }
      })
      expect(scanOsc7(run.stdout + run.stderr).path).toBe('/')
    })
  })
})
