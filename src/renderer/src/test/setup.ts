import { afterEach, expect, vi } from 'vitest'
import * as matchers from '@testing-library/jest-dom/matchers'
import { cleanup } from '@testing-library/react'

/**
 * What every test gets, whether it renders anything or not.
 *
 * The matchers and the cleanup are only meaningful to a component test, and
 * cost a Node test nothing but the import. What is here for everyone is the
 * bridge: `window.td` is how the interface reaches the main process, and a
 * component that renders without it does not fail in a readable way — it fails
 * inside an effect, on the third render, saying that something is not a
 * function. So it is stubbed once, here, and a test that cares about a call
 * says so by replacing that one method.
 */
expect.extend(matchers)

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

/** Every method answers, and answers with nothing in particular. */
function stub<T extends object>(answers: Partial<T> = {}): T {
  return new Proxy({ ...answers } as Record<string, unknown>, {
    get(target, key: string) {
      if (key in target) return target[key]
      return () => Promise.resolve(undefined)
    }
  }) as T
}

if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'td', {
    writable: true,
    configurable: true,
    value: {
      localUsername: 'tester',
      store: stub({
        load: () => Promise.resolve({ version: 1, groups: [], sessions: [] }),
        reorderSessions: () => Promise.resolve(),
        reorderGroups: () => Promise.resolve()
      }),
      gitFolder: stub({
        list: () => Promise.resolve({ trees: [], overrides: [], repos: [] })
      }),
      inventory: stub({
        list: () => Promise.resolve({ sources: [], overrides: [], trees: [] }),
        gitAvailable: () => Promise.resolve(true)
      }),
      collections: stub({ list: () => Promise.resolve([]) }),
      credentials: stub({ list: () => Promise.resolve([]) }),
      snippets: stub({ list: () => Promise.resolve([]) }),
      vault: stub({ status: () => Promise.resolve({ exists: false, unlocked: false }) }),
      clipboard: stub({ read: () => '', write: () => undefined }),
      ssh: stub(),
      sftp: stub(),
      rdp: stub(),
      ui: stub({ onZoom: () => () => undefined, onForwardKey: () => () => undefined }),
      updates: stub({
        getState: () => Promise.resolve({ status: 'idle' }),
        onState: () => () => undefined
      }),
      dialogs: stub(),
      auth: stub({ onPrompt: () => () => undefined })
    }
  })
}
