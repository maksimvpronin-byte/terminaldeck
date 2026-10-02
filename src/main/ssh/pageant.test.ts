import { describe, it, expect } from 'vitest'
import { Duplex, PassThrough } from 'stream'
import { AGENT_FAILURE, AnsweringPageant, answering } from './pageant'

/** SSH_AGENTC_REQUEST_IDENTITIES, framed. */
const REQUEST_IDENTITIES = Buffer.from([0, 0, 0, 1, 11])

/** Everything a stream says until it ends, or what it had said after a second. */
function readAll(stream: Duplex): Promise<{ data: Buffer; ended: boolean }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    const done = (ended: boolean): void => resolve({ data: Buffer.concat(chunks), ended })
    stream.on('data', (chunk: Buffer) => chunks.push(chunk))
    stream.on('end', () => done(true))
    setTimeout(() => done(false), 1000)
  })
}

describe('a forwarded agent request', () => {
  /**
   * Off Windows, ssh2's own Pageant path cannot start its helper, which fails
   * the request exactly as a Pageant that is not running does.
   */
  it('is answered with a failure when Pageant cannot be reached, then ends', async () => {
    const stream = await new Promise<Duplex>((resolve, reject) =>
      new AnsweringPageant().getStream((err, s) => (err || !s ? reject(err) : resolve(s)))
    )
    const said = readAll(stream)
    stream.write(REQUEST_IDENTITIES)
    expect(await said).toEqual({ data: AGENT_FAILURE, ended: true })
  })

  it('ends the channel it is piped to, so the remote ssh stops waiting', async () => {
    const broken = new Duplex({
      read() {},
      write(_chunk, _encoding, done) {
        done(new Error('Pageant is not running'))
      }
    })
    const channel = new PassThrough()
    const stream = answering(broken)
    stream.pipe(channel)
    const said = readAll(channel)
    stream.write(REQUEST_IDENTITIES)
    expect(await said).toEqual({ data: AGENT_FAILURE, ended: true })
  })

  it('passes an answering agent through untouched', async () => {
    const agent = new PassThrough()
    const stream = answering(agent)
    const said = readAll(stream)
    stream.write(REQUEST_IDENTITIES)
    agent.end()
    expect(await said).toEqual({ data: REQUEST_IDENTITIES, ended: true })
  })
})
