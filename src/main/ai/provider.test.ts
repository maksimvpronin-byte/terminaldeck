import { describe, it, expect } from 'vitest'
import { createServer } from 'http'
import { once } from 'events'
import { diagnosticCommand } from './catalog'
import { endpointUrl, validateSettings, redact, chat, parseDecision } from './provider'
import type { AiAnalysis } from '../../shared/ai'

it.each([
  'https://user:pass@example.org/v1',
  'https://example.org/v1?key=secret',
  'file:///tmp/key',
  'http://example.org/v1'
])('rejects unsafe endpoint %s', (url) => {
  expect(() => endpointUrl(url)).toThrow()
})
it('preserves an API prefix and allows loopback for compatible local providers', () => {
  expect(endpointUrl('https://example.org/proxy/v1/')).toBe('https://example.org/proxy/v1')
  expect(endpointUrl('http://127.0.0.1:9999/v1')).toContain('9999')
})
it('does not send a retained key to a changed endpoint', () => {
  expect(() =>
    validateSettings(
      { endpoint: 'https://new.example/v1', model: 'test', consent: true },
      { endpoint: 'https://old.example/v1', model: 'test', apiKey: 'secret', consent: true }
    )
  ).toThrow('new API key')
})
it('filters explicit key, credentials, bearer tokens and multiline private keys', () => {
  const text =
    'known-secret password="some password" Authorization: Bearer abc123 https://user:pass@host\n-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----'
  const out = redact(text, ['known-secret'])
  for (const secret of ['known-secret', 'some password', 'abc123', 'user:pass', '\nabc\n'])
    expect(out).not.toContain(secret)
})
describe('catalog validation', () => {
  it.each([
    'nginx.service;id',
    '--help',
    '$(id).service',
    'nginx.service\nreboot',
    '../nginx.service'
  ])('rejects unsafe service %s', (value) =>
    expect(() => diagnosticCommand('service_logs', value, 'en')).toThrow()
  )
  it.each(['/', '/var/../etc', '/proc', '/var/$(id)', '/var/a b'])(
    'rejects unsafe/heavy directory %s',
    (value) => expect(() => diagnosticCommand('directory_size', value, 'en')).toThrow()
  )
  it('only emits one known command with validated arguments', () => {
    expect(diagnosticCommand('smart', '/dev/nvme0n1', 'en').command).toBe(
      "smartctl -a '/dev/nvme0n1'"
    )
    expect(() => diagnosticCommand('__proto__', undefined, 'en')).toThrow()
    expect(() => diagnosticCommand('os', '/etc/shadow', 'en')).toThrow()
  })
})
it('refuses invented report evidence', () => {
  const data = {
    explanation: 'test',
    report: {
      summary: 'test',
      findings: [
        {
          severity: 'critical',
          observation: 'bad',
          hypothesis: 'maybe',
          recommendation: 'check',
          evidence: ['invented']
        }
      ],
      limitations: []
    }
  }
  expect(() =>
    parseDecision(JSON.stringify(data), { steps: [] } as unknown as AiAnalysis, true)
  ).toThrow('evidence')
})
it('speaks Chat Completions over HTTP and never follows redirects with the API key', async () => {
  const seen: { url: string; body: string; auth?: string }[] = []
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    seen.push({ url: req.url!, body, auth: req.headers.authorization })
    if (req.url === '/redirect/chat/completions') {
      res.writeHead(302, { Location: '/stolen' })
      res.end()
      return
    }
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'OK' } }] }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address() as { port: number }
  const endpoint = `http://127.0.0.1:${address.port}/v1`
  const config = { endpoint, model: 'test-model', apiKey: 'test-key', consent: true }
  try {
    expect(
      await chat(config, [{ role: 'user', content: 'test' }], new AbortController().signal)
    ).toBe('OK')
    expect(seen[0].url).toBe('/v1/chat/completions')
    expect(JSON.parse(seen[0].body)).toMatchObject({ model: 'test-model', stream: false })
    expect(seen[0].auth).toBe('Bearer test-key')
    await expect(
      chat(
        { ...config, endpoint: endpoint.replace('/v1', '/redirect') },
        [],
        new AbortController().signal
      )
    ).rejects.toThrow()
    expect(seen).toHaveLength(2)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

it('bounds multibyte context while retaining marked head/tail excerpts', async () => {
  const { modelMessages, REQUEST_LIMIT } = await import('./provider')
  const analysis = {
    language: 'ru',
    host: 'fixture',
    startedAt: Date.now(),
    steps: Array.from({ length: 24 }, (_, i) => ({
      id: `step-${i}`,
      tool: 'kernel',
      status: 'completed',
      proposedAt: Date.now(),
      result: {
        stdout: 'начало ' + 'Ж'.repeat(60000) + ' конец',
        stderr: 'ошибка '.repeat(5000),
        durationMs: 1,
        exitCode: 0,
        outcome: 'completed',
        truncated: false
      }
    }))
  } as unknown as AiAnalysis
  const messages = modelMessages(analysis, true, '')
  expect(Buffer.byteLength(JSON.stringify(messages))).toBeLessThan(REQUEST_LIMIT - 1000)
  expect(messages[1].content).toContain('omitted')
  expect(messages[1].content).toContain('конец')
})
