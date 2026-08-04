import type { ITheme } from 'xterm'

export interface TerminalSettings {
  fontFamily: string
  fontSize: number
  scrollback: number
  cursorBlink: boolean
  cursorStyle: 'block' | 'underline' | 'bar'
  themeName: string
}

/** Chrome colours, mapped onto the CSS custom properties in styles.css. */
export interface UiPalette {
  bg0: string
  bg1: string
  bg2: string
  bg3: string
  border: string
  text: string
  textDim: string
  accent: string
  accentDim: string
  danger: string
  success: string
}

export interface ThemeDef {
  terminal: ITheme
  ui: UiPalette
}

export const THEMES: Record<string, ThemeDef> = {
  'TerminalDeck Dark': {
    terminal: {
      background: '#17181c',
      foreground: '#e4e6eb',
      cursor: '#5b9dff',
      selectionBackground: '#2e4a75'
    },
    ui: {
      bg0: '#17181c',
      bg1: '#1e2025',
      bg2: '#26282e',
      bg3: '#303339',
      border: '#383b42',
      text: '#e4e6eb',
      textDim: '#9aa0ab',
      accent: '#5b9dff',
      accentDim: '#2e4a75',
      danger: '#e5534b',
      success: '#3fb950'
    }
  },
  'Solarized Dark': {
    terminal: {
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
    ui: {
      bg0: '#002b36',
      bg1: '#01313d',
      bg2: '#073642',
      bg3: '#0d4553',
      border: '#12586b',
      text: '#93a1a1',
      textDim: '#6c8080',
      accent: '#268bd2',
      accentDim: '#1a4a6e',
      danger: '#dc322f',
      success: '#859900'
    }
  },
  Dracula: {
    terminal: {
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
    ui: {
      bg0: '#282a36',
      bg1: '#2f313f',
      bg2: '#383a4a',
      bg3: '#44475a',
      border: '#4d5066',
      text: '#f8f8f2',
      textDim: '#a2a5b8',
      accent: '#bd93f9',
      accentDim: '#54446f',
      danger: '#ff5555',
      success: '#50fa7b'
    }
  },
  Light: {
    terminal: {
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
    },
    ui: {
      bg0: '#ffffff',
      bg1: '#f4f5f7',
      bg2: '#e8eaed',
      bg3: '#dcdfe4',
      border: '#c8ccd2',
      text: '#22252b',
      textDim: '#6a707b',
      accent: '#1f5fbf',
      accentDim: '#bcd2f2',
      danger: '#c7254e',
      success: '#2f7d32'
    }
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

export function themeDefOf(settings: TerminalSettings): ThemeDef {
  return THEMES[settings.themeName] ?? THEMES['TerminalDeck Dark']
}

export function themeOf(settings: TerminalSettings): ITheme {
  return themeDefOf(settings).terminal
}

/** Pushes the palette onto :root so the whole app follows the terminal theme. */
export function applyUiPalette(settings: TerminalSettings): void {
  const { ui } = themeDefOf(settings)
  const root = document.documentElement.style
  root.setProperty('--bg-0', ui.bg0)
  root.setProperty('--bg-1', ui.bg1)
  root.setProperty('--bg-2', ui.bg2)
  root.setProperty('--bg-3', ui.bg3)
  root.setProperty('--border', ui.border)
  root.setProperty('--text', ui.text)
  root.setProperty('--text-dim', ui.textDim)
  root.setProperty('--accent', ui.accent)
  root.setProperty('--accent-dim', ui.accentDim)
  root.setProperty('--danger', ui.danger)
  root.setProperty('--success', ui.success)
  // Native form controls and scrollbars follow this.
  root.setProperty('color-scheme', settings.themeName === 'Light' ? 'light' : 'dark')
}
