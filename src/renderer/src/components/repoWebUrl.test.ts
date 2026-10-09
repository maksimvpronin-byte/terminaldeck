import { describe, it, expect } from 'vitest'
import { repoWebUrl } from './repoWebUrl'

function url(repoUrl: string, paths: string[] = [], branch?: string): string | undefined {
  return repoWebUrl({ repoUrl, paths, branch })
}

describe('repoWebUrl', () => {
  it('turns the scp-like SSH form into the GitLab page of the one path', () => {
    expect(url('git@gitlab.corp.ru:infra/inventory.git', ['prod/hosts.yml'], 'main')).toBe(
      'https://gitlab.corp.ru/infra/inventory/-/tree/main/prod/hosts.yml'
    )
  })

  it('drops the SSH port and user of an ssh:// address', () => {
    expect(url('ssh://git@gitlab.corp.ru:2222/infra/inventory.git', ['inv/'], 'dev')).toBe(
      'https://gitlab.corp.ru/infra/inventory/-/tree/dev/inv'
    )
  })

  it('keeps the HTTPS port but never a login or token written into the address', () => {
    expect(url('https://user:secret@git.corp.ru:8443/a/b.git', ['./hosts.ini'], 'main')).toBe(
      'https://git.corp.ru:8443/a/b/-/tree/main/hosts.ini'
    )
  })

  it('stays on plain HTTP when the repository is cloned over it', () => {
    expect(url('http://git.lan/a/b', ['x.yml'], 'main')).toBe(
      'http://git.lan/a/b/-/tree/main/x.yml'
    )
  })

  it('names the default branch HEAD when none is set', () => {
    expect(url('git@gitlab.corp.ru:a/b.git', ['hosts.yml'])).toBe(
      'https://gitlab.corp.ru/a/b/-/tree/HEAD/hosts.yml'
    )
  })

  it('opens the repository itself when several paths are read', () => {
    expect(url('git@gitlab.corp.ru:a/b.git', ['prod.yml', 'stage.yml'])).toBe(
      'https://gitlab.corp.ru/a/b'
    )
    expect(url('git@gitlab.corp.ru:a/b.git', ['prod.yml', 'stage.yml'], 'release/1.2')).toBe(
      'https://gitlab.corp.ru/a/b/-/tree/release/1.2'
    )
  })

  it('uses the layouts of GitHub and Bitbucket', () => {
    expect(url('git@github.com:me/inv.git', ['hosts.yml'], 'main')).toBe(
      'https://github.com/me/inv/tree/main/hosts.yml'
    )
    expect(url('https://bitbucket.org/me/inv.git', ['hosts.yml'], 'main')).toBe(
      'https://bitbucket.org/me/inv/src/main/hosts.yml'
    )
  })

  it('reads a path typed with Windows backslashes', () => {
    expect(
      url(
        'https://gitlabsvr.corp.ru/gitlab/osa/iac.git',
        ['inventory\\k8s-test\\K8S1\\inventory.yml'],
        'master'
      )
    ).toBe(
      'https://gitlabsvr.corp.ru/gitlab/osa/iac/-/tree/master/inventory/k8s-test/K8S1/inventory.yml'
    )
  })

  it('encodes what a URL cannot carry as is', () => {
    expect(url('git@gitlab.corp.ru:a/b.git', ['my hosts/#1.yml'], 'main')).toBe(
      'https://gitlab.corp.ru/a/b/-/tree/main/my%20hosts/%231.yml'
    )
  })

  it('has nothing for a clone with no web page', () => {
    expect(url('/srv/git/inventory.git', ['hosts.yml'])).toBeUndefined()
    expect(url('file:///srv/git/inventory.git')).toBeUndefined()
    expect(url('')).toBeUndefined()
    expect(url('C:\\repos\\inventory')).toBeUndefined()
  })
})
