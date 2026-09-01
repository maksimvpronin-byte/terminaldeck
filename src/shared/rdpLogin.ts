/**
 * Splitting a Windows login into the two fields RDP carries it in.
 *
 * This app stores one string, because that is what people type and what every
 * other protocol here takes. RDP has separate fields for the domain and the
 * account, and the client sets them literally: a `DOMAIN\user` left whole in
 * the account field is an account genuinely called `DOMAIN\user`, which no
 * host has, and the failure it produces says only "logon failure".
 *
 * The two spellings are not symmetric, which is the part worth knowing:
 *
 *   DOMAIN\user  is a NetBIOS name and an account, and must be separated;
 *   user@domain  is a user principal name, and must not be — it is a single
 *                identifier that the far end looks up whole, and splitting it
 *                produces a domain that does not resolve.
 */

export interface RdpLogin {
  username: string
  domain?: string
}

export function splitLogin(login: string): RdpLogin {
  const trimmed = login.trim()
  const slash = trimmed.lastIndexOf('\\')
  if (slash > 0) {
    return { domain: trimmed.slice(0, slash), username: trimmed.slice(slash + 1) }
  }
  // A UPN, or a bare name. Both go across whole.
  return { username: trimmed }
}
