import { describe, it, expect } from 'vitest'
import { repoUrlHasSecret, withoutRepoSecret } from './repoSecret'

describe('repoUrlHasSecret', () => {
  it('finds a password or token after a user', () => {
    expect(repoUrlHasSecret('https://user:TOKEN@gitlab.example.com/ops/inv.git')).toBe(true)
    expect(repoUrlHasSecret('https://oauth2:glpat-abc@gitlab.example.com/ops/inv.git')).toBe(true)
    expect(repoUrlHasSecret('ssh://git:hunter2@example.com:2222/inv.git')).toBe(true)
  })

  it('finds a token standing where the user would be', () => {
    expect(repoUrlHasSecret('https://ghp_abcdefghijklmnop@github.com/o/r.git')).toBe(true)
    expect(repoUrlHasSecret('https://github_pat_11AB@github.com/o/r.git')).toBe(true)
    expect(repoUrlHasSecret(`https://${'a1'.repeat(20)}@github.com/o/r.git`)).toBe(true)
  })

  it('leaves alone what carries no secret', () => {
    expect(repoUrlHasSecret('https://gitlab.example.com/ops/inv.git')).toBe(false)
    expect(repoUrlHasSecret('https://deploy@gitlab.example.com/ops/inv.git')).toBe(false)
    expect(repoUrlHasSecret('git@github.com:o/r.git')).toBe(false)
    expect(repoUrlHasSecret('ssh://git@example.com:2222/inv.git')).toBe(false)
    expect(repoUrlHasSecret('/srv/git/inv.git')).toBe(false)
    expect(repoUrlHasSecret('C:\\repos\\inv')).toBe(false)
    // An @ in the path is not a login.
    expect(repoUrlHasSecret('https://example.com/team@ops/inv.git')).toBe(false)
  })
})

describe('withoutRepoSecret', () => {
  it('keeps the user and drops the password', () => {
    expect(withoutRepoSecret('https://user:TOKEN@gitlab.example.com/ops/inv.git')).toBe(
      'https://user@gitlab.example.com/ops/inv.git'
    )
  })

  it('drops a token that stood for the user', () => {
    expect(withoutRepoSecret('https://ghp_abcdefghijklmnop@github.com/o/r.git')).toBe(
      'https://github.com/o/r.git'
    )
  })

  it('returns an address with nothing to take out unchanged', () => {
    for (const url of [
      'https://deploy@gitlab.example.com/ops/inv.git',
      'git@github.com:o/r.git',
      'https://example.com/team@ops/inv.git'
    ]) {
      expect(withoutRepoSecret(url)).toBe(url)
    }
  })
})
