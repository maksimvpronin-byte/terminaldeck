import type { TerminalDeckApi } from './index'

declare global {
  interface Window {
    td: TerminalDeckApi
  }
}
