// @vitest-environment jsdom
import { beforeEach, it, expect } from 'vitest'
import { DEFAULT_SETTINGS, loadSettings } from './settings'

beforeEach(() => localStorage.clear())
const put = (value: unknown): void =>
  localStorage.setItem('terminaldeck.terminalSettings', JSON.stringify(value))

it('keeps valid preferences and supplies defaults for newly added fields', () => {
  put({ fontSize: 16, language: 'en', lockAfterMinutes: 0, externalEditor: 'code {file}' })
  expect(loadSettings()).toMatchObject({
    fontSize: 16,
    language: 'en',
    lockAfterMinutes: 0,
    externalEditor: 'code {file}',
    cursorStyle: DEFAULT_SETTINGS.cursorStyle
  })
})
it('rejects invalid types and enums before they reach the terminal', () => {
  put({
    fontSize: 'big',
    scrollback: -1,
    cursorStyle: 'invalid',
    rightClick: 'launch',
    themeName: '__proto__',
    language: 'other',
    cursorBlink: null,
    lockAfterMinutes: -1
  })
  expect(loadSettings()).toEqual(DEFAULT_SETTINGS)
})
it.each([null, [], 123])('uses defaults for a non-object settings file %j', (value) => {
  put(value)
  expect(loadSettings()).toEqual(DEFAULT_SETTINGS)
})
it('bounds corrupt numeric settings and ignores unknown fields', () => {
  put({
    fontSize: 1e100,
    scrollback: 1e100,
    lockAfterMinutes: 1e100,
    treeRowHeight: 400,
    unknown: true
  })
  const settings = loadSettings()
  expect(settings).toMatchObject({
    fontSize: DEFAULT_SETTINGS.fontSize,
    scrollback: DEFAULT_SETTINGS.scrollback,
    lockAfterMinutes: DEFAULT_SETTINGS.lockAfterMinutes,
    treeRowHeight: 40
  })
  expect(settings).not.toHaveProperty('unknown')
})

it('validates in-session edits before saving and applying them', async () => {
  const { useStore } = await import('./store')
  useStore.setState({ settings: { ...DEFAULT_SETTINGS, externalEditor: 'code {file}' } })
  useStore.getState().updateSettings({ scrollback: -1, fontSize: NaN, themeName: '__proto__' })
  expect(useStore.getState().settings).toEqual({
    ...DEFAULT_SETTINGS,
    externalEditor: 'code {file}'
  })
  expect(loadSettings()).toEqual(useStore.getState().settings)
})
