import type { ITheme } from 'xterm'

export interface TerminalSettings {
  fontFamily: string
  fontSize: number
  scrollback: number
  cursorBlink: boolean
  cursorStyle: 'block' | 'underline' | 'bar'
  themeName: string
}

export const THEMES: Record<string, ITheme> = {
  'TerminalDeck Dark': {
    background: '#17181c',
    foreground: '#e4e6eb',
    cursor: '#5b9dff',
    selectionBackground: '#2e4a75'
  },
  'Solarized Dark': {
    background: '#002b36',
    foreground: '#93a1a1',
    cursor: '#93a1a1',
    selectionBackground: '#073642',
    black: '#073642',
    red: '#dc322f',
    green: '#859900',
    yellow: '#b58900',
    blue: '#268bd2',
    magenta: '#d33682',
    cyan: '#2aa198',
    white: '#eee8d5'
  },
  Dracula: {
    background: '#282a36',
    foreground: '#f8f8f2',
    cursor: '#f8f8f0',
    selectionBackground: '#44475a',
    black: '#21222c',
    red: '#ff5555',
    green: '#50fa7b',
    yellow: '#f1fa8c',
    blue: '#bd93f9',
    magenta: '#ff79c6',
    cyan: '#8be9fd',
    white: '#f8f8f2'
  },
  Light: {
    background: '#fafafa',
    foreground: '#2e3138',
    cursor: '#2e3138',
    selectionBackground: '#c8d8f0',
    black: '#2e3138',
    red: '#c7254e',
    green: '#3f7f3f',
    yellow: '#8a6d00',
    blue: '#1f5fbf',
    magenta: '#a03fa0',
    cyan: '#2a8f8f',
    white: '#d9d9d9'
  }
}

export const DEFAULT_SETTINGS: TerminalSettings = {
  fontFamily: 'Menlo, Consolas, monospace',
  fontSize: 13,
  scrollback: 10000,
  cursorBlink: true,
  cursorStyle: 'block',
  themeName: 'TerminalDeck Dark'
}

export const FONT_CHOICES = [
  'Menlo, Consolas, monospace',
  'SF Mono, Menlo, monospace',
  'JetBrains Mono, Menlo, monospace',
  'Fira Code, Menlo, monospace',
  'Courier New, monospace'
]

const KEY = 'terminaldeck.terminalSettings'

export function loadSettings(): TerminalSettings {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return DEFAULT_SETTINGS
    // Merge so settings added in a later version get their defaults.
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<TerminalSettings>) }
  } catch {
    return DEFAULT_SETTINGS
  }
}

export function saveSettings(settings: TerminalSettings): void {
  localStorage.setItem(KEY, JSON.stringify(settings))
}

export function themeOf(settings: TerminalSettings): ITheme {
  return THEMES[settings.themeName] ?? THEMES['TerminalDeck Dark']
}
