import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
  componentStack: string
}

/**
 * Turns a renderer crash into something readable.
 *
 * Without this, any exception thrown during render unmounts the whole tree and
 * leaves the window painted in the Electron background colour — a black screen
 * with nothing to act on, and no way to tell a crash apart from a hang. The
 * message and stack matter more than the styling here.
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, componentStack: '' }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    this.setState({ componentStack: info.componentStack ?? '' })
    // Also on the console, for anyone who does have DevTools open.
    console.error('TerminalDeck crashed while rendering', error, info)
  }

  private report(): string {
    const { error, componentStack } = this.state
    return [
      `${error?.name}: ${error?.message}`,
      '',
      error?.stack ?? '(no stack)',
      '',
      'Component stack:',
      componentStack || '(none)'
    ].join('\n')
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children

    return (
      <div className="crash-screen">
        <h1>TerminalDeck hit an error and stopped drawing</h1>
        <p>
          Your SSH sessions are gone with the window, but nothing on disk has been touched —
          saved hosts, inventories and the vault are all intact.
        </p>
        <pre className="crash-details">{this.report()}</pre>
        <div className="crash-actions">
          <button className="primary" onClick={() => window.location.reload()}>
            Reload the app
          </button>
          <button onClick={() => window.td?.clipboard?.write(this.report())}>
            Copy this report
          </button>
        </div>
        <p className="settings-note">
          If it crashes again straight away, the saved layout may be at fault. Reloading with a
          clean layout is the quickest way to find out:
          <br />
          <code>localStorage.removeItem(&apos;terminaldeck.layout&apos;)</code> in the console
          (View → Toggle Developer Tools), then reload.
        </p>
      </div>
    )
  }
}
