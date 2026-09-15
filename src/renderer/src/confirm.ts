/**
 * `window.confirm`, with the keyboard given back afterwards.
 *
 * On Windows the page's own dialog leaves the window unable to focus anything
 * once it closes: clicks land, but an input takes no caret and no keystroke
 * until the window is minimised and restored. The main process undoes that by
 * taking the window's focus away and handing it back — see `uiRefocus` in
 * main/keyboardCapture.ts, where what was tried and what worked is written down.
 *
 * Every confirmation in the interface goes through here; the linter refuses a
 * bare `window.confirm`, which is how the bug would come back.
 */
export function confirmAction(message: string): boolean {
  // eslint-disable-next-line no-restricted-properties -- this is the one place it is called
  const answer = window.confirm(message)
  window.td.ui.refocus()
  return answer
}
