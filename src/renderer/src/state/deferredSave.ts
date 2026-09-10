/** Coalesce UI changes; still save during a long drag and before the page leaves. */
export function deferredSave(save: () => void, delay = 250, maxWait = 2000) {
  let quiet: ReturnType<typeof setTimeout> | undefined
  let deadline: ReturnType<typeof setTimeout> | undefined
  function flush(): void {
    if (!quiet && !deadline) return
    clearTimeout(quiet)
    clearTimeout(deadline)
    quiet = deadline = undefined
    save()
  }
  return {
    flush,
    schedule(): void {
      clearTimeout(quiet)
      quiet = setTimeout(flush, delay)
      deadline ??= setTimeout(flush, maxWait)
    }
  }
}
