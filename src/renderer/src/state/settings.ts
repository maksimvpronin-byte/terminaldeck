import type { ITheme } from '@xterm/xterm'
import type { CursorStyle, ResolvedAppearance } from '../../../shared/types'
import { preferredLanguage, type Language } from '../i18n/language'

/**
 * The application-wide defaults. The appearance half doubles as the bottom of
 * the per-group / per-host inheritance chain, so it satisfies ResolvedAppearance.
 */
export interface TerminalSettings extends ResolvedAppearance {
  /** What the interface is written in. See renderer/src/i18n. */
  language: Language
  fontFamily: string
  fontSize: number
  scrollback: number
  cursorBlink: boolean
  cursorStyle: CursorStyle
  themeName: string
  /** Selecting text in a terminal puts it on the clipboard right away. */
  copyOnSelect: boolean
  /** Right-click either pastes immediately or opens the terminal menu. */
  rightClick: 'paste' | 'menu'
  /**
   * Command used to open a remote file for editing. Empty hands the file to the
   * OS default. `{file}` is replaced by the path, or it is appended if absent.
   */
  externalEditor: string
  /**
   * How long the application may sit untouched before the vault locks, in
   * minutes. Zero never locks it.
   *
   * Untouched means no key, no pointer movement, no click and no scroll —
   * anywhere in the window, including inside a terminal. It was fifteen minutes
   * and not adjustable, which is too eager for someone reading a long build log
   * on a machine nobody else can reach, and far too patient for a laptop in an
   * open office.
   */
  lockAfterMinutes: number
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
  /**
   * Light themes have to say so rather than be guessed at from their name:
   * native scrollbars and form controls follow `color-scheme`, and getting it
   * wrong leaves dark widgets sitting on a white page.
   */
  light?: boolean
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
    },
    light: true
  },
  Nord: {
    terminal: {
      background: '#2e3440',
      foreground: '#d8dee9',
      cursor: '#88c0d0',
      selectionBackground: '#434c5e',
      black: '#3b4252',
      red: '#bf616a',
      green: '#a3be8c',
      yellow: '#ebcb8b',
      blue: '#81a1c1',
      magenta: '#b48ead',
      cyan: '#88c0d0',
      white: '#e5e9f0'
    },
    ui: {
      bg0: '#2e3440',
      bg1: '#343b4a',
      bg2: '#3b4252',
      bg3: '#434c5e',
      border: '#4c566a',
      text: '#d8dee9',
      textDim: '#8f9aad',
      accent: '#88c0d0',
      accentDim: '#3b5561',
      danger: '#bf616a',
      success: '#a3be8c'
    }
  },
  'Gruvbox Dark': {
    terminal: {
      background: '#282828',
      foreground: '#ebdbb2',
      cursor: '#fabd2f',
      selectionBackground: '#504945',
      black: '#282828',
      red: '#fb4934',
      green: '#b8bb26',
      yellow: '#fabd2f',
      blue: '#83a598',
      magenta: '#d3869b',
      cyan: '#8ec07c',
      white: '#ebdbb2'
    },
    ui: {
      bg0: '#282828',
      bg1: '#32302f',
      bg2: '#3c3836',
      bg3: '#504945',
      border: '#665c54',
      text: '#ebdbb2',
      textDim: '#a89984',
      accent: '#83a598',
      accentDim: '#3d4f4c',
      danger: '#fb4934',
      success: '#b8bb26'
    }
  },
  'One Dark': {
    terminal: {
      background: '#282c34',
      foreground: '#abb2bf',
      cursor: '#61afef',
      selectionBackground: '#3e4451',
      black: '#282c34',
      red: '#e06c75',
      green: '#98c379',
      yellow: '#e5c07b',
      blue: '#61afef',
      magenta: '#c678dd',
      cyan: '#56b6c2',
      white: '#abb2bf'
    },
    ui: {
      bg0: '#282c34',
      bg1: '#2f343d',
      bg2: '#363c46',
      bg3: '#3e4451',
      border: '#4b5263',
      text: '#abb2bf',
      textDim: '#7f8899',
      accent: '#61afef',
      accentDim: '#2c4f70',
      danger: '#e06c75',
      success: '#98c379'
    }
  },
  'Tokyo Night': {
    terminal: {
      background: '#1a1b26',
      foreground: '#c0caf5',
      cursor: '#7aa2f7',
      selectionBackground: '#2f334d',
      black: '#15161e',
      red: '#f7768e',
      green: '#9ece6a',
      yellow: '#e0af68',
      blue: '#7aa2f7',
      magenta: '#bb9af7',
      cyan: '#7dcfff',
      white: '#a9b1d6'
    },
    ui: {
      bg0: '#1a1b26',
      bg1: '#1f2130',
      bg2: '#24283b',
      bg3: '#2f334d',
      border: '#3b4261',
      text: '#c0caf5',
      textDim: '#7f88b3',
      accent: '#7aa2f7',
      accentDim: '#2e3c66',
      danger: '#f7768e',
      success: '#9ece6a'
    }
  },
  'Catppuccin Mocha': {
    terminal: {
      background: '#1e1e2e',
      foreground: '#cdd6f4',
      cursor: '#89b4fa',
      selectionBackground: '#45475a',
      black: '#45475a',
      red: '#f38ba8',
      green: '#a6e3a1',
      yellow: '#f9e2af',
      blue: '#89b4fa',
      magenta: '#cba6f7',
      cyan: '#89dceb',
      white: '#bac2de'
    },
    ui: {
      bg0: '#1e1e2e',
      bg1: '#232338',
      bg2: '#313244',
      bg3: '#45475a',
      border: '#585b70',
      text: '#cdd6f4',
      textDim: '#a6adc8',
      accent: '#89b4fa',
      accentDim: '#35446b',
      danger: '#f38ba8',
      success: '#a6e3a1'
    }
  },
  Monokai: {
    terminal: {
      background: '#272822',
      foreground: '#f8f8f2',
      cursor: '#f8f8f0',
      selectionBackground: '#49483e',
      black: '#272822',
      red: '#f92672',
      green: '#a6e22e',
      yellow: '#e6db74',
      blue: '#66d9ef',
      magenta: '#ae81ff',
      cyan: '#a1efe4',
      white: '#f8f8f2'
    },
    ui: {
      bg0: '#272822',
      bg1: '#2f302a',
      bg2: '#3a3b33',
      bg3: '#49483e',
      border: '#5a594d',
      text: '#f8f8f2',
      textDim: '#a8a89e',
      accent: '#66d9ef',
      accentDim: '#2c5d68',
      danger: '#f92672',
      success: '#a6e22e'
    }
  },
  'Night Owl': {
    terminal: {
      background: '#011627',
      foreground: '#d6deeb',
      cursor: '#82aaff',
      selectionBackground: '#1d3b53',
      black: '#011627',
      red: '#ef5350',
      green: '#22da6e',
      yellow: '#c5e478',
      blue: '#82aaff',
      magenta: '#c792ea',
      cyan: '#21c7a8',
      white: '#d6deeb'
    },
    ui: {
      bg0: '#011627',
      bg1: '#06202f',
      bg2: '#0b2942',
      bg3: '#123356',
      border: '#1d3b53',
      text: '#d6deeb',
      textDim: '#7c98ab',
      accent: '#82aaff',
      accentDim: '#23407a',
      danger: '#ef5350',
      success: '#22da6e'
    }
  },
  'Solarized Light': {
    terminal: {
      background: '#fdf6e3',
      foreground: '#657b83',
      cursor: '#586e75',
      selectionBackground: '#eee8d5',
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
      bg0: '#fdf6e3',
      bg1: '#f5eeda',
      bg2: '#eee8d5',
      bg3: '#e4ddc8',
      border: '#d6cfb8',
      text: '#586e75',
      textDim: '#93a1a1',
      accent: '#268bd2',
      accentDim: '#b6d5ee',
      danger: '#dc322f',
      success: '#859900'
    },
    light: true
  },
  'GitHub Light': {
    terminal: {
      background: '#ffffff',
      foreground: '#1f2328',
      cursor: '#0969da',
      selectionBackground: '#b6d8ff',
      black: '#24292f',
      red: '#cf222e',
      green: '#116329',
      yellow: '#7d4e00',
      blue: '#0969da',
      magenta: '#8250df',
      cyan: '#1b7c83',
      white: '#6e7781'
    },
    ui: {
      bg0: '#ffffff',
      bg1: '#f6f8fa',
      bg2: '#eaeef2',
      bg3: '#dde3ea',
      border: '#d0d7de',
      text: '#1f2328',
      textDim: '#656d76',
      accent: '#0969da',
      accentDim: '#b6d8ff',
      danger: '#cf222e',
      success: '#1a7f37'
    },
    light: true
  }
}

/**
 * The theme list split for the pickers, so thirteen entries stay browsable and
 * a light theme is not stumbled into by accident.
 */
export const THEME_GROUPS: Array<{ label: string; names: string[] }> = [
  { label: 'Dark', names: Object.keys(THEMES).filter((n) => !THEMES[n].light) },
  { label: 'Light', names: Object.keys(THEMES).filter((n) => THEMES[n].light) }
]

export const DEFAULT_THEME = 'TerminalDeck Dark'

export const DEFAULT_SETTINGS: TerminalSettings = {
  // What the operating system asks for, until someone says otherwise.
  language: preferredLanguage(),
  fontFamily: 'Menlo, Consolas, monospace',
  fontSize: 13,
  scrollback: 10000,
  cursorBlink: true,
  cursorStyle: 'block',
  themeName: DEFAULT_THEME,
  copyOnSelect: true,
  rightClick: 'paste',
  externalEditor: '',
  // What it always was, now that it can be something else.
  lockAfterMinutes: 15
}

/**
 * Which settings the Terminal tab owns — and, therefore, the only ones its
 * "Reset to defaults" is entitled to touch.
 *
 * The button handed over the whole of `DEFAULT_SETTINGS`, so resetting the font
 * size also put the interface back into another language, forgot the external
 * editor and moved the idle lock back to fifteen minutes. Three settings on
 * other tabs, changed by a button that names none of them.
 */
export const TERMINAL_KEYS = [
  'fontFamily',
  'fontSize',
  'scrollback',
  'themeName',
  'cursorStyle',
  'cursorBlink',
  'copyOnSelect',
  'rightClick'
] as const satisfies ReadonlyArray<keyof TerminalSettings>

/** Everything else, listed so that a new setting has to be placed deliberately. */
export const OTHER_KEYS = [
  'language',
  'externalEditor',
  'lockAfterMinutes'
] as const satisfies ReadonlyArray<keyof TerminalSettings>

/** The defaults for the Terminal tab alone. */
export function terminalDefaults(): Partial<TerminalSettings> {
  return Object.fromEntries(TERMINAL_KEYS.map((key) => [key, DEFAULT_SETTINGS[key]]))
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

/** Looks a theme up by name, falling back when a saved name no longer exists. */
export function themeByName(name: string): ThemeDef {
  return THEMES[name] ?? THEMES[DEFAULT_THEME]
}

export function themeDefOf(settings: { themeName: string }): ThemeDef {
  return themeByName(settings.themeName)
}

export function themeOf(settings: { themeName: string }): ITheme {
  return themeDefOf(settings).terminal
}

/**
 * Pushes the palette onto :root so the whole app follows the terminal theme.
 *
 * Driven by the global setting alone. A group or host with a theme of its own
 * recolours its terminal only — repainting the sidebar and tab bar every time
 * the focus moved between panes would be unusable.
 */
export function applyUiPalette(settings: TerminalSettings): void {
  const def = themeDefOf(settings)
  const { ui } = def
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
  root.setProperty('color-scheme', def.light ? 'light' : 'dark')
}
