// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render } from '@testing-library/react'
import type { ForwardedKey, RdpView } from '../../../shared/types'

// ⌘Tab and fn are a Mac's alone; the rest of the screen's tests run as whatever jsdom is.
vi.mock('../state/keys', async (original) => ({
  ...(await original<typeof import('../state/keys')>()),
  IS_MAC: true
}))

import RemoteScreen from './RemoteScreen'

const desktopSend = vi.fn()
const forwarded = new Set<(key: ForwardedKey) => void>()

beforeEach(() => {
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => null })
  Object.defineProperty(navigator, 'keyboard', {
    configurable: true,
    value: { lock: vi.fn(async () => undefined), unlock: vi.fn() }
  })
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    }
  )
  window.matchMedia = vi.fn(
    () => ({ addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList
  )
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    {} as unknown as CanvasRenderingContext2D
  )
  window.td.rdp.desktopStart = vi.fn(async () => 'desktop')
  desktopSend.mockClear()
  window.td.rdp.desktopSend = desktopSend
  window.td.rdp.desktopStop = vi.fn(async () => undefined)
  window.td.rdp.onDesktopFrame = () => () => undefined
  window.td.rdp.onDesktopCursor = () => () => undefined
  window.td.rdp.onDesktopEvent = () => () => undefined
  window.td.ui.setKeyboardCapture = vi.fn()
  forwarded.clear()
  window.td.ui.onForwardKey = (cb) => {
    forwarded.add(cb)
    return () => {
      forwarded.delete(cb)
    }
  }
  macLanguage = 'en'
  languageListeners.clear()
  window.td.ui.inputLanguage = async () => macLanguage
  window.td.ui.onInputLanguage = (cb) => {
    languageListeners.add(cb)
    return () => {
      languageListeners.delete(cb)
    }
  }
})

/** The Mac's input language, as the module in main reports it. */
let macLanguage = 'en'
const languageListeners = new Set<(language: string) => void>()

/** fn on the Mac: the layout changes, and main says so. */
function switchMacLanguage(language: string): void {
  macLanguage = language
  act(() => {
    for (const cb of languageListeners) cb(language)
  })
}

const WIN = { code: 0x5b, ext: true }
const CTRL = { code: 0x1d, ext: false }
const ALT = { code: 0x38, ext: false }
const TAB = { code: 0x0f, ext: false }
const press = (key: { code: number; ext: boolean }, down: boolean) => ({ a: 'key', ...key, down })

const keys = (): unknown[] =>
  desktopSend.mock.calls.filter(([, fields]) => fields.a === 'key').map(([, fields]) => fields)

/** ⌘Tab as it reaches the window once macOS lets it through: taken by main. */
function commandTab(shift = false): void {
  act(() => {
    for (const cb of forwarded) cb({ code: 'Tab', control: false, shift, alt: false, meta: true })
  })
}

async function open(rdpLook: RdpView | null): Promise<HTMLElement> {
  const view = render(
    <RemoteScreen
      sessionId="host"
      look={rdpLook}
      visible
      active
      onPhase={vi.fn()}
      onNotice={vi.fn()}
      onMeasured={vi.fn()}
    />
  )
  await act(async () => {})
  const screen = view.container.querySelector<HTMLElement>('.graphical-screen')!
  act(() => screen.focus())
  desktopSend.mockClear()
  return screen
}

const look = (commandAsControl: boolean): RdpView => ({
  resolution: 'fit',
  desktopWidth: 1920,
  desktopHeight: 1080,
  pixelBudget: 3.5,
  magnification: 0,
  sendDensity: false,
  commandAsControl,
  typeAsText: true
})

describe('letters on a Mac', () => {
  const unicode = (): unknown[] =>
    desktopSend.mock.calls.filter(([, fields]) => fields.a === 'unicode').map(([, f]) => f)

  it('go as the characters the Mac typed, by default, with commands still as keys', async () => {
    const screen = await open(null)
    // "d" on a Mac switched to Russian with fn.
    fireEvent.keyDown(screen, { code: 'KeyD', key: 'в' })
    fireEvent.keyUp(screen, { code: 'KeyD', key: 'в' })
    expect(unicode()).toEqual([
      { a: 'unicode', code: 0x432, down: true },
      { a: 'unicode', code: 0x432, down: false }
    ])
    expect(keys()).toEqual([])

    desktopSend.mockClear()
    fireEvent.keyDown(screen, { code: 'ControlLeft', key: 'Control', ctrlKey: true })
    fireEvent.keyDown(screen, { code: 'KeyC', key: 'с', ctrlKey: true })
    fireEvent.keyUp(screen, { code: 'KeyC', key: 'с', ctrlKey: true })
    expect(unicode()).toEqual([])
    expect(keys()).toEqual([
      press(CTRL, true),
      press({ code: 0x2e, ext: false }, true),
      press({ code: 0x2e, ext: false }, false)
    ])
  })

  it('go as keys for a host that turned text off', async () => {
    const screen = await open({ ...look(false), typeAsText: false })
    fireEvent.keyDown(screen, { code: 'KeyD', key: 'в' })
    fireEvent.keyUp(screen, { code: 'KeyD', key: 'в' })
    expect(unicode()).toEqual([])
    expect(keys()).toEqual([
      press({ code: 0x20, ext: false }, true),
      press({ code: 0x20, ext: false }, false)
    ])
  })
})

describe('⌘Tab on a Mac', () => {
  it('switches windows as Alt+Tab, holding Alt for as long as ⌘ is held', async () => {
    const screen = await open(null)
    fireEvent.keyDown(screen, { code: 'MetaLeft', key: 'Meta', metaKey: true })
    commandTab()
    commandTab()
    fireEvent.keyUp(screen, { code: 'MetaLeft', key: 'Meta' })
    expect(keys()).toEqual([
      press(WIN, true),
      // Alt before the Windows key comes up, so Start does not open.
      press(ALT, true),
      press(WIN, false),
      press(TAB, true),
      press(TAB, false),
      press(TAB, true),
      press(TAB, false),
      press(ALT, false)
    ])
  })

  it('lets go of the Ctrl that ⌘ stands for, and does not let go of it twice', async () => {
    const screen = await open(look(true))
    fireEvent.keyDown(screen, { code: 'MetaLeft', key: 'Meta', metaKey: true })
    commandTab()
    fireEvent.keyUp(screen, { code: 'MetaLeft', key: 'Meta' })
    expect(keys()).toEqual([
      press(CTRL, true),
      press(ALT, true),
      press(CTRL, false),
      press(TAB, true),
      press(TAB, false),
      press(ALT, false)
    ])
  })

  it('goes back to ⌘ as usual once the switch is over', async () => {
    const screen = await open(null)
    fireEvent.keyDown(screen, { code: 'MetaLeft', key: 'Meta', metaKey: true })
    commandTab()
    fireEvent.keyUp(screen, { code: 'MetaLeft', key: 'Meta' })
    desktopSend.mockClear()
    fireEvent.keyDown(screen, { code: 'MetaLeft', key: 'Meta', metaKey: true })
    fireEvent.keyUp(screen, { code: 'MetaLeft', key: 'Meta' })
    expect(keys()).toEqual([press(WIN, true), press(WIN, false)])
  })
})

describe('Mac copy and paste', () => {
  it('keeps Command+C and Command+V as Control shortcuts in the remote desktop', async () => {
    const screen = await open(look(true))
    for (const [code, key] of [
      ['KeyC', 'с'],
      ['KeyV', 'м']
    ]) {
      fireEvent.keyDown(screen, { code: 'MetaLeft', key: 'Meta', metaKey: true })
      fireEvent.keyDown(screen, { code, key, metaKey: true })
      fireEvent.keyUp(screen, { code, key, metaKey: true })
      fireEvent.keyUp(screen, { code: 'MetaLeft', key: 'Meta' })
    }
    expect(keys()).toEqual(
      [0x2e, 0x2f].flatMap((code) => [
        press(CTRL, true),
        press({ code, ext: false }, true),
        press({ code, ext: false }, false),
        press(CTRL, false)
      ])
    )
    expect(desktopSend.mock.calls.some(([, fields]) => fields.a === 'unicode')).toBe(false)
  })
})

describe('the far side’s layout, following the Mac’s', () => {
  const SHIFT = { code: 0x2a, ext: false }
  const altShift = [press(ALT, true), press(SHIFT, true), press(SHIFT, false), press(ALT, false)]
  const letter = (code: number) => [
    { a: 'unicode', code, down: true },
    { a: 'unicode', code, down: false }
  ]
  const sent = (): unknown[] =>
    desktopSend.mock.calls
      .map(([, fields]) => fields)
      .filter((fields) => fields.a === 'key' || fields.a === 'unicode')

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const wait = (ms: number): void =>
    act(() => {
      vi.advanceTimersByTime(ms)
    })
  /** Past the pause the switch waits for, and the presses themselves. */
  const settle = (): void => wait(1000)

  it('presses Alt+Shift over there once the keys are still, each time fn changes it', async () => {
    await open(null)
    switchMacLanguage('ru')
    settle()
    expect(keys()).toEqual(altShift)
    // Told again without a change: nothing to do.
    switchMacLanguage('ru')
    settle()
    expect(keys()).toEqual(altShift)
    switchMacLanguage('en')
    settle()
    expect(keys()).toEqual([...altShift, ...altShift])
  })

  it('waits for a pause in the typing, so no letter lands mid-switch', async () => {
    const screen = await open(null)
    switchMacLanguage('ru')
    // Typing straight on, a key every 200 ms: nothing is pressed over there.
    for (const key of ['й', 'ц', 'у']) {
      fireEvent.keyDown(screen, { code: 'KeyQ', key })
      fireEvent.keyUp(screen, { code: 'KeyQ', key })
      wait(200)
    }
    expect(keys()).toEqual([])
    settle()
    expect(sent()).toEqual([...letter(0x439), ...letter(0x446), ...letter(0x443), ...altShift])
  })

  it('catches up on coming back, after a change made with another app in front', async () => {
    const screen = await open(null)
    const elsewhere = document.createElement('input')
    document.body.append(elsewhere)
    act(() => elsewhere.focus())
    switchMacLanguage('ru')
    settle()
    expect(keys()).toEqual([])
    act(() => screen.focus())
    await act(async () => {})
    settle()
    expect(keys()).toEqual(altShift)
    elsewhere.remove()
  })

  it('holds back a key pressed while the switch is under way until it is done', async () => {
    const screen = await open(null)
    switchMacLanguage('ru')
    // The pause is over and Alt has just gone down over there.
    wait(600)
    fireEvent.keyDown(screen, { code: 'KeyE', key: 'у' })
    fireEvent.keyUp(screen, { code: 'KeyE', key: 'у' })
    settle()
    // Not Alt+E, which is a menu: the letter, after Alt has come up.
    expect(sent()).toEqual([...altShift, ...letter(0x443)])
  })

  it('keeps its hands off while Shift is held here', async () => {
    const screen = await open(null)
    fireEvent.keyDown(screen, { code: 'ShiftLeft', key: 'Shift', shiftKey: true })
    desktopSend.mockClear()
    switchMacLanguage('ru')
    settle()
    expect(keys()).toEqual([])
  })
  it('retries alignment after releasing a modifier held through the idle timeout', async () => {
    const screen = await open(null)
    fireEvent.keyDown(screen, { code: 'ShiftLeft', key: 'Shift', shiftKey: true })
    switchMacLanguage('ru')
    settle()
    desktopSend.mockClear()
    fireEvent.keyUp(screen, { code: 'ShiftLeft', key: 'Shift' })
    desktopSend.mockClear()
    settle()
    expect(keys()).toEqual(altShift)
  })
})

describe('the language letters go in, shown and put right from the pane', () => {
  const SHIFT = { code: 0x2a, ext: false }
  const altShift = [press(ALT, true), press(SHIFT, true), press(SHIFT, false), press(ALT, false)]

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  })
  afterEach(() => {
    vi.useRealTimers()
  })
  const wait = (ms: number): void =>
    act(() => {
      vi.advanceTimersByTime(ms)
    })

  async function mount(rdpLook: RdpView | null, onTypingLanguage = vi.fn()) {
    const props = {
      sessionId: 'host',
      visible: true,
      active: true,
      onPhase: vi.fn(),
      onNotice: vi.fn(),
      onMeasured: vi.fn(),
      onTypingLanguage
    }
    const view = render(<RemoteScreen {...props} look={rdpLook} />)
    await act(async () => {})
    const screen = view.container.querySelector<HTMLElement>('.graphical-screen')!
    act(() => screen.focus())
    await act(async () => {})
    desktopSend.mockClear()
    const fix = (n: number): void =>
      view.rerender(<RemoteScreen {...props} look={rdpLook} layoutFix={n} />)
    const label = (): string | null =>
      view.container.querySelector('.graphical-language')?.textContent ?? null
    return { screen, fix, label }
  }

  it('tells the pane the Mac’s language, and nothing when keys go as keys', async () => {
    const typing = vi.fn()
    await mount(look(false), typing)
    expect(typing).toHaveBeenLastCalledWith('en')
    switchMacLanguage('ru')
    expect(typing).toHaveBeenLastCalledWith('ru')

    const physical = vi.fn()
    await mount({ ...look(false), typeAsText: false }, physical)
    expect(physical).toHaveBeenLastCalledWith(null)
  })

  it('shows the language large on fn and on coming back, then lets it go', async () => {
    const { label } = await mount(null)
    // Coming to the desktop says what letters will be typed in.
    expect(label()).toBe('EN')
    wait(1000)
    expect(label()).toBeNull()
    switchMacLanguage('ru')
    expect(label()).toBe('RU')
    wait(1000)
    expect(label()).toBeNull()
  })

  it('turns the far layout round once on a click, and keeps following fn after', async () => {
    const { fix } = await mount(null)
    fix(1)
    wait(100)
    expect(keys()).toEqual(altShift)
    // Believed level now, so the same language again presses nothing…
    switchMacLanguage('en')
    wait(1000)
    expect(keys()).toEqual(altShift)
    // …and a real change presses it once more.
    switchMacLanguage('ru')
    wait(1000)
    expect(keys()).toEqual([...altShift, ...altShift])
  })
})
