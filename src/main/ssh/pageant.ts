import { PageantAgent, type GetStreamCallback } from 'ssh2'
import { Duplex } from 'stream'

/** SSH_AGENT_FAILURE as the agent protocol frames it: a length of one, then the code. */
export const AGENT_FAILURE = Buffer.from([0, 0, 0, 1, 5])

/**
 * Pageant, for a forwarded agent that must always get an answer.
 *
 * ssh2 hands a forwarded agent request to Pageant without asking whether it is
 * running. When it is not — the usual case on a Windows machine with no agent
 * at all — the request fails inside ssh2, and the channel it came on is neither
 * answered nor closed. An `ssh` run on the remote host then waits for it
 * forever, right after `Permanently added … to the list of known hosts`, and
 * never gets as far as asking for a password.
 */
export class AnsweringPageant extends PageantAgent {
  constructor() {
    // Pageant is found by its window, not a path; ssh2 ignores this.
    super('pageant')
  }

  getStream(cb: GetStreamCallback): void {
    super.getStream((err, stream) => (err || !stream ? cb(err) : cb(null, answering(stream))))
  }
}

/**
 * An agent connection that says no instead of going silent.
 *
 * The request that failed is answered with SSH_AGENT_FAILURE and the stream
 * ends, which is what an agent with nothing to offer looks like: the remote
 * `ssh` notes it and moves on to its other ways of signing in. The next request
 * comes on a channel of its own, so Pageant started later is found then.
 */
export function answering(inner: Duplex): Duplex {
  let over = false
  const fail = (): void => {
    if (over) return
    over = true
    outer.push(AGENT_FAILURE)
    outer.push(null)
  }
  const outer = new Duplex({
    read() {},
    write(chunk: Buffer, _encoding, done) {
      if (over) return done()
      // A failed write is answered, not passed on: the channel writing to us
      // has no use for the error, only for a reply.
      inner.write(chunk, (err) => {
        if (err) fail()
        done()
      })
    },
    final(done) {
      inner.end()
      done()
    },
    destroy(err, done) {
      inner.destroy()
      done(err)
    }
  })
  inner.on('data', (data: Buffer) => outer.push(data))
  inner.on('end', () => {
    if (over) return
    over = true
    outer.push(null)
  })
  /*
   * ssh2's Pageant socket swallows its own error: it is destroyed, emits
   * 'close' and nothing else — no 'error', no 'end'. `pipe` ends the channel
   * only on 'end', so a close that comes without one is the failure.
   */
  inner.on('error', fail)
  inner.on('close', fail)
  return outer
}
