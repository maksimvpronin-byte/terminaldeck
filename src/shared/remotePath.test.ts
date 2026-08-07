import { describe, it, expect } from 'vitest'
import { baseNameOf, joinRemote, normalizeRemotePath, parentOf, segmentsOf } from './remotePath'

describe('normalizeRemotePath', () => {
  it('leaves a plain absolute path alone', () => {
    expect(normalizeRemotePath('/var/log')).toBe('/var/log')
  })

  it('collapses repeated and trailing slashes', () => {
    expect(normalizeRemotePath('//var//log//')).toBe('/var/log')
    expect(normalizeRemotePath('/var/log/')).toBe('/var/log')
  })

  it('keeps the root as a single slash', () => {
    expect(normalizeRemotePath('/')).toBe('/')
    expect(normalizeRemotePath('///')).toBe('/')
  })

  it('resolves . and ..', () => {
    expect(normalizeRemotePath('/var/log/../lib')).toBe('/var/lib')
    expect(normalizeRemotePath('/var/./log')).toBe('/var/log')
  })

  it('cannot be walked above the root', () => {
    expect(normalizeRemotePath('/../..')).toBe('/')
    expect(normalizeRemotePath('/var/../../etc')).toBe('/etc')
  })

  it('keeps a relative path relative, including leading ..', () => {
    expect(normalizeRemotePath('logs/nginx')).toBe('logs/nginx')
    expect(normalizeRemotePath('../logs')).toBe('../logs')
    expect(normalizeRemotePath('.')).toBe('.')
    expect(normalizeRemotePath('')).toBe('.')
  })
})

describe('parentOf', () => {
  it('steps up one level', () => {
    expect(parentOf('/var/log/nginx')).toBe('/var/log')
    expect(parentOf('/var')).toBe('/')
  })

  it('makes the root its own parent, so Up cannot run off the top', () => {
    expect(parentOf('/')).toBe('/')
  })

  it('normalises before stepping, so a trailing slash changes nothing', () => {
    expect(parentOf('/var/log/')).toBe('/var')
  })
})

describe('baseNameOf', () => {
  it('returns the last segment', () => {
    expect(baseNameOf('/var/log/syslog')).toBe('syslog')
    expect(baseNameOf('/var/log/')).toBe('log')
  })

  it('calls the root itself', () => {
    expect(baseNameOf('/')).toBe('/')
  })
})

describe('joinRemote', () => {
  it('joins whether or not the parent ends in a slash', () => {
    expect(joinRemote('/var/log', 'syslog')).toBe('/var/log/syslog')
    expect(joinRemote('/var/log/', 'syslog')).toBe('/var/log/syslog')
    expect(joinRemote('/', 'etc')).toBe('/etc')
  })
})

describe('segmentsOf', () => {
  it('starts at the root and ends at the directory itself', () => {
    expect(segmentsOf('/var/log/nginx')).toEqual([
      { name: '/', path: '/' },
      { name: 'var', path: '/var' },
      { name: 'log', path: '/var/log' },
      { name: 'nginx', path: '/var/log/nginx' }
    ])
  })

  it('gives the root a single crumb', () => {
    expect(segmentsOf('/')).toEqual([{ name: '/', path: '/' }])
  })

  it('leaves an unresolved relative path as one crumb', () => {
    expect(segmentsOf('.')).toEqual([{ name: '.', path: '.' }])
  })
})
