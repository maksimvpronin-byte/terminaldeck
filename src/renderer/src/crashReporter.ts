/**
 * Last-resort crash reporting, imported before anything else.
 *
 * The React error boundary only covers errors thrown while rendering. An
 * exception raised while a module is still being evaluated happens before React
 * mounts at all, and used to leave nothing but a black window. This paints the
 * message straight into the DOM, with no dependency on React, the stylesheet or
 * the preload bridge — any of which may be the thing that failed.
 */

let reported = false

function paint(title: string, detail: string): void {
  const root = document.getElementById('root')
  // If React already put something on screen, its own boundary owns the error.
  if (!root || root.childElementCount > 0 || reported) return
  reported = true

  root.setAttribute(
    'style',
    'padding:24px;font:13px/1.5 Menlo,Consolas,monospace;color:#e4e6eb;background:#17181c;height:100vh;overflow:auto'
  )
  const heading = document.createElement('h1')
  heading.setAttribute('style', 'font-size:15px;margin:0 0 12px')
  heading.textContent = title
  const pre = document.createElement('pre')
  pre.setAttribute(
    'style',
    'white-space:pre-wrap;word-break:break-word;background:#26282e;border:1px solid #383b42;border-radius:6px;padding:12px;margin:0'
  )
  pre.textContent = detail
  root.replaceChildren(heading, pre)
}

function describe(value: unknown): string {
  if (value instanceof Error) {
    return `${value.name}: ${value.message}\n\n${value.stack ?? '(no stack)'}`
  }
  return String(value)
}

window.addEventListener('error', (event) => {
  const where = event.filename ? `\n\nat ${event.filename}:${event.lineno}:${event.colno}` : ''
  paint('TerminalDeck failed to start', describe(event.error ?? event.message) + where)
})

window.addEventListener('unhandledrejection', (event) => {
  paint('TerminalDeck failed to start', describe(event.reason))
})
