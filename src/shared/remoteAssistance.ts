/** The useful part of a Remote Assistance invitation returned by RpcShadow2. */
export interface RemoteAssistanceInvitation {
  /** The RCTICKET value, kept intact for the later channel handshake. */
  ticket: string
  /** The host named by the first RDP endpoint in the ticket. */
  host: string
  /** The port named by the first RDP endpoint in the ticket. */
  port: number
  username?: string
  passStub?: string
  encrypted: boolean
  startsAt?: string
  durationSeconds?: number
  /** All listener endpoints advertised by the actual Windows invitation. */
  endpoints?: Array<{ host: string; port: number }>
  /** Invitation id from the Windows Desktop Sharing document. */
  invitationId?: string
  /** Base64-encoded X.509 certificate from the Windows invitation. */
  certificateDerBase64?: string
  /** Key hash and its advertised algorithm from the invitation. */
  keyHashBase64?: string
  keyHashAlgorithm?: string
}

export interface RemoteAssistanceEndpoint {
  host: string
  port: number
}

/** Prefer routable IPv4 over a link-local IPv6 listener advertised by Windows. */
export function selectRemoteAssistanceEndpoint(
  invitation: RemoteAssistanceInvitation
): RemoteAssistanceEndpoint {
  const endpoints = invitation.endpoints?.length
    ? invitation.endpoints
    : [{ host: invitation.host, port: invitation.port }]
  return (
    endpoints.find(({ host }) => isIpv4(host)) ??
    endpoints.find(({ host }) => !isLinkLocalIpv6(host)) ??
    endpoints[0]
  )
}

/**
 * Parses the XML returned by WinStationRcmShadow2.
 *
 * Remote Assistance invitations are small XML documents, but the project does
 * not otherwise need a browser XML parser in the main process. This deliberately
 * accepts only the UPLOADDATA element and its quoted attributes, rejects
 * malformed/ambiguous input, and leaves the opaque RCTICKET untouched.
 */
export function parseRemoteAssistanceInvitation(xml: string): RemoteAssistanceInvitation {
  const actual = xml.match(/<E\b([^>]*)>([\s\S]*)<\/E>/i)
  if (actual) return parseWindowsInvitation(actual[1], actual[2], xml)

  const match = xml.match(/<(?:[A-Za-z][\w.-]*:)?UPLOADDATA\b([^>]*)\/?\s*>/i)
  if (!match) throw new Error('Remote Assistance invitation has no UPLOADDATA element')

  const attrs = attributes(match[1])
  const ticket = attrs.RCTICKET
  if (!ticket) throw new Error('Remote Assistance invitation has no RCTICKET')

  const endpoint = ticket.match(/^[^,]*,[^,]*,([^;]+);/)
  if (!endpoint) throw new Error('Remote Assistance invitation has no RDP endpoint')

  const { host, port } = parseEndpoint(endpoint[1])
  const durationSeconds = numberAttribute(attrs.DtLength)

  return {
    ticket,
    host,
    port,
    username: attrs.USERNAME || undefined,
    passStub: attrs.PassStub || undefined,
    encrypted: attrs.RCTICKETENCRYPTED === '1',
    startsAt: attrs.DtStart || undefined,
    durationSeconds,
    endpoints: [{ host, port }]
  }
}

/** Parses the compact E/A/C/T/L invitation emitted by WinStationRcmShadow2. */
function parseWindowsInvitation(
  rootSource: string,
  body: string,
  xml: string
): RemoteAssistanceInvitation {
  const root = attributes(rootSource)
  const authorisation = body.match(/<A\b([^>]*)\/?\s*>/i)
  const invitationAttributes = authorisation ? attributes(authorisation[1]) : root
  const endpointMatches = [...body.matchAll(/<L\b([^>]*)\/?\s*>/gi)]
  const endpoints = endpointMatches.map((match) => {
    const attrs = attributes(match[1])
    const host = attrs.N
    const port = Number(attrs.P)
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('Remote Assistance invitation has an invalid listener endpoint')
    }
    return { host, port }
  })
  if (endpoints.length === 0) {
    throw new Error('Remote Assistance invitation has no listener endpoint')
  }

  const first = endpoints[0]
  return {
    ticket: xml,
    host: first.host,
    port: first.port,
    encrypted: true,
    endpoints,
    invitationId: invitationAttributes.ID || undefined,
    certificateDerBase64: compactBase64(invitationAttributes.CE),
    keyHashBase64:
      extractHash(invitationAttributes.KH2)?.hash ?? (invitationAttributes.KH || undefined),
    keyHashAlgorithm: extractHash(invitationAttributes.KH2)?.algorithm
  }
}

function attributes(source: string): Record<string, string> {
  const result: Record<string, string> = {}
  const pattern = /([A-Za-z][A-Za-z0-9_]*)\s*=\s*(["'])(.*?)\2/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(source))) result[match[1]] = decodeEntities(match[3])
  return result
}

function decodeEntities(value: string): string {
  return value
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal: string) => String.fromCodePoint(Number(decimal)))
}

function compactBase64(value: string | undefined): string | undefined {
  if (!value) return undefined
  return value.replace(/\s+/g, '') || undefined
}

function extractHash(value: string | undefined): { algorithm: string; hash: string } | undefined {
  if (!value) return undefined
  const separator = value.indexOf(':')
  if (separator < 1) return undefined
  const algorithm = value.slice(0, separator).toLowerCase()
  const hash = compactBase64(value.slice(separator + 1))
  return hash ? { algorithm, hash } : undefined
}

function isIpv4(host: string): boolean {
  return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(host)
}

function isLinkLocalIpv6(host: string): boolean {
  return /^fe80:/i.test(host)
}

function parseEndpoint(value: string): { host: string; port: number } {
  const trimmed = value.trim()
  const bracketed = trimmed.match(/^\[([^\]]+)\]:(\d+)$/)
  const plain = trimmed.match(/^(.+):(\d+)$/)
  const match = bracketed ?? plain
  if (!match) throw new Error('Remote Assistance invitation has an invalid RDP endpoint')

  const port = Number(match[2])
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Remote Assistance invitation has an invalid RDP port')
  }
  return { host: match[1], port }
}

function numberAttribute(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined
  const number = Number(value)
  if (!Number.isInteger(number) || number < 0) {
    throw new Error('Remote Assistance invitation has an invalid duration')
  }
  return number
}
